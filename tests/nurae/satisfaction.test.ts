/**
 * NURAE — V00.09.000 satisfaction-round tests:
 *   - the agent SKILL library (manifests, playbooks, skill_read tool)
 *   - the hardened agent-envelope parser (no raw JSON ever reaches users)
 *   - instant owner alerts (flow completion + payment, end-to-end pipeline)
 *   - the admin monitor surface (/api/admin/bots, delete-customer cascade)
 *   - user vanity slugs + the dashboard API
 */

import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, telegramState } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const { ensureOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const { parseAgentReply, toolDataPreview } = await import('../../src/lib/nurae/agents/bot-builder');
const { executeTool } = await import('../../src/lib/nurae/agents/tools');
const { AGENT_SKILLS, skillsFor, skillPlaybook, skillManifest } = await import('../../src/lib/nurae/agents/skills');
const { createUserBot, updateUserBot } = await import('../../src/lib/nurae/bots/user-bots');
const { sendOwnerAlert, ownerFlowAlert, ownerPaymentAlert } = await import('../../src/lib/nurae/bots/owner-notify');
const { testBotTextTurn } = await import('../../src/lib/nurae/bots/user-bots');
const { userSlug, parseUserSlug } = await import('../../src/lib/nurae/slug');

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

let counter = 0;
async function makeUser(name: string): Promise<{ id: string; email: string }> {
  counter += 1;
  const email = `t31-${counter}-${Date.now()}@example.com`;
  const user = await db.user.create({
    data: { name, email, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email };
}

async function makeBot(userId: string, behaviors: unknown[], name: string): Promise<string> {
  const result = await createUserBot(userId, {
    name,
    behaviors: behaviors as never,
  });
  if (!result.bot) throw new Error(`bot create failed: ${result.error}`);
  await db.bot.update({ where: { id: result.bot.id }, data: { telegramTokenRef: SecretManager.encrypt('1234567890:AAValidFormatTokenForTesting1234') } });
  return result.bot.id;
}

const ORDER_BEHAVIORS = [
  {
    id: 'order',
    title: 'Order',
    when: { type: 'command', command: '/order' },
    steps: [
      { type: 'collect', collect: { attribute: 'client_name', prompt: 'Your name?' } },
      { type: 'collect', collect: { attribute: 'dish', prompt: 'What dish?' } },
      { type: 'message', text: 'Thanks {{client_name}} — one {{dish}} on the way!' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe('agent skill library', () => {
  test('manifests serve builder and operator audiences with real ids', () => {
    const builder = skillManifest('builder');
    const operator = skillManifest('operator');
    expect(builder.length).toBeGreaterThanOrEqual(8);
    expect(operator.length).toBeGreaterThanOrEqual(5);
    expect(builder.map((s) => s.id)).toContain('order-form-alerts');
    expect(operator.map((s) => s.id)).toContain('morning-brief');
    for (const s of [...builder, ...operator]) {
      expect(s.description.length).toBeGreaterThan(20);
    }
    expect(skillsFor('builder').every((s) => s.audience === 'builder' || s.audience === 'both')).toBe(true);
    expect(AGENT_SKILLS.length).toBe(builder.length + operator.length);
  });

  test('playbooks reference real steps and skill_read executes them', async () => {
    const text = skillPlaybook('order-form-alerts');
    expect(text).toContain('STEPS');
    expect(text).toContain('bot_set_owner_chat');

    expect(skillPlaybook('no-such-skill')).toBeNull();

    const ctx = { userId: 'u1', sessionId: 's1' };
    const record = await executeTool(ctx, 'skill_read', { skill: 'build-from-brief' }, 1);
    expect(record.status).toBe('ok');
    expect(String((record.data as { text: string }).text)).toContain('bot_create_draft');

    const bad = await executeTool(ctx, 'skill_read', { skill: 'nope' }, 2);
    expect(bad.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Envelope parser hardening
// ---------------------------------------------------------------------------

describe('agent envelope parser (BR-025)', () => {
  test('parses a valid envelope with actions', () => {
    const parsed = parseAgentReply('{"message":"On it","actions":[{"tool":"bots_list","args":{}}],"done":false}');
    expect(parsed.message).toBe('On it');
    expect(parsed.actions).toEqual([{ tool: 'bots_list', args: {} }]);
    expect(parsed.done).toBe(false);
    expect(parsed.jsonOk).toBe(true);
  });

  test('parses an envelope wrapped in markdown code fences', () => {
    const parsed = parseAgentReply('```json\n{"message":"Working","actions":[],"done":true}\n```');
    expect(parsed.message).toBe('Working');
    expect(parsed.jsonOk).toBe(true);
  });

  test('a broken envelope never leaks raw JSON — salvages the message field', () => {
    const raw = '{"message": "Building your bot now", "actions": [{"tool": "bot_create_draft"} broken}';
    const parsed = parseAgentReply(raw);
    expect(parsed.message).toBe('Building your bot now');
    expect(parsed.message).not.toContain('{');
    expect(parsed.actions).toEqual([]);
  });

  test('broken envelope without a message shows only the surrounding prose', () => {
    const parsed = parseAgentReply('Sure thing! {"actions": [oops]} one moment.');
    expect(parsed.message.replace(/\s+/g, ' ')).toBe('Sure thing! one moment.');
    expect(parsed.message).not.toContain('actions');
  });

  test('a pure broken envelope yields the clean notice, not the blob', () => {
    // Unclosed, no message field → clean notice.
    const parsed = parseAgentReply('{"actions": [oops, and then the model kept going');
    expect(parsed.jsonOk).toBe(false);
    expect(parsed.message).not.toContain('"actions"');
    expect(parsed.message.toLowerCase()).toContain('malformed');
    // Truncated message field salvages what the model managed to say.
    const salvaged = parseAgentReply('{"message": "I was building your shop when I got cut');
    expect(salvaged.message).toBe('I was building your shop when I got cut');
  });

  test('toolDataPreview truncates long outputs and handles unserializable data', () => {
    expect(toolDataPreview(undefined)).toBeUndefined();
    expect(toolDataPreview({ a: 1 })).toBe('{"a":1}');
    const long = toolDataPreview('x'.repeat(900), 700);
    expect(long?.length).toBe(701);
    expect(long?.endsWith('…')).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toolDataPreview(cyclic)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Instant owner alerts
// ---------------------------------------------------------------------------

describe('owner alerts (BR-026)', () => {
  test('completed collect flows push the whole intake to the owner chat', async () => {
    const user = await makeUser('Alert Owner');
    const botId = await makeBot(user.id, ORDER_BEHAVIORS, 'Restaurant Bot');
    const updated = await updateUserBot(user.id, botId, { ownerChatId: '4242424242' });
    expect(updated.bot?.ownerChatId).toBe('4242424242');

    await testBotTextTurn(user.id, botId, '/order'); // asks name
    await testBotTextTurn(user.id, botId, 'Maria'); // asks dish
    const turn = await testBotTextTurn(user.id, botId, 'Jollof'); // completes the flow

    // The customer got the confirmation through the pipeline sender…
    expect(turn.sends.some((s) => s.text.includes('Maria') && s.text.includes('Jollof'))).toBe(true);

    // …and the owner got the Telegram alert through the real adapter path.
    const alert = telegramState.sends.find((s) => s.chatId === '4242424242');
    expect(alert).toBeTruthy();
    expect(alert?.text).toContain('New order / form completed');
    expect(alert?.text).toContain('client_name: Maria');
    expect(alert?.text).toContain('dish: Jollof');
    expect(alert?.text).toContain('Restaurant Bot');

    const logRow = await db.log.findFirst({ where: { botId, event: 'OWNER_NOTIFIED' }, orderBy: { timestamp: 'desc' } });
    expect(logRow).toBeTruthy();
  });

  test('no owner chat id → no alert, flow still completes', async () => {
    const user = await makeUser('Quiet Owner');
    const botId = await makeBot(user.id, ORDER_BEHAVIORS, 'Silent Bot');

    await testBotTextTurn(user.id, botId, '/order');
    await testBotTextTurn(user.id, botId, 'Ada');
    const turn = await testBotTextTurn(user.id, botId, 'Suya');

    expect(turn.sends.some((s) => s.text.includes('Ada'))).toBe(true);
    expect(telegramState.sends.some((s) => s.text.includes('Silent Bot') && s.text.includes('New order / form completed'))).toBe(false);
  });

  test('sendOwnerAlert is honest about missing wiring and payment alerts format', async () => {
    const user = await makeUser('Partial Owner');
    const botId = await makeBot(user.id, [], 'No Alerts Bot');

    const unwired = await sendOwnerAlert(botId, ownerPaymentAlert('No Alerts Bot', '777', 'Deal', 25, 'XTR', 'p_x'));
    expect(unwired.sent).toBe(false);
    expect(unwired.error).toContain('no owner chat id');

    await updateUserBot(user.id, botId, { ownerChatId: '7777777' });
    const wired = await sendOwnerAlert(botId, ownerPaymentAlert('No Alerts Bot', '777', 'Deal', 25, 'XTR', 'p_x'));
    expect(wired.sent).toBe(true);
    const payment = telegramState.sends.find((s) => s.chatId === '7777777');
    expect(payment?.text).toContain('New payment received');
    expect(payment?.text).toContain('25 XTR');
  });
});

// ---------------------------------------------------------------------------
// Admin monitor + delete cascade
// ---------------------------------------------------------------------------

describe('admin monitor (BR-027)', () => {
  test('GET /api/admin/bots lists platform and customer bots with owners', async () => {
    await ensureOfficialBot();
    const user = await makeUser('Bot Owner');
    await makeBot(user.id, [], 'Customer Bot One');

    const { GET } = await import('../../src/app/api/admin/bots/route');
    const res = await GET(new Request('http://localhost/api/admin/bots'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bots: Array<{ name: string; owner: { kind: string; email: string | null }; audience: number }>;
    };
    const customerBot = body.bots.find((b) => b.name === 'Customer Bot One');
    expect(customerBot).toBeTruthy();
    expect(customerBot?.owner.kind).toBe('customer');
    expect(customerBot?.owner.email).toBe(user.email);
    expect(body.bots.some((b) => b.owner.kind === 'platform')).toBe(true);
  });

  test('account deletion is NOT an admin power — the endpoint is gone (owner decision)', async () => {
    // V00.09.000: the owner ordered the deletion power removed entirely.
    // The route module must not exist; if anyone reintroduces it, this fails.
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const routePath = join(process.cwd(), 'src', 'app', 'api', 'admin', 'customers', '[id]', 'route.ts');
    expect(existsSync(routePath)).toBe(false);
    const client = await import('../../src/lib/nurae-client/api');
    expect((client.nuraeApi as Record<string, unknown>).deleteCustomer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Vanity slugs + dashboard API
// ---------------------------------------------------------------------------

describe('vanity slugs (BR-028)', () => {
  test('userSlug is stable, collision-free and parseable', () => {
    const slug = userSlug({ name: 'Maria Silva', id: 'cuid123456abcdef9012' });
    expect(slug).toBe(`maria-silva_${'abcdef9012'.slice(-6)}`);
    const parsed = parseUserSlug(slug);
    expect(parsed?.uid).toBe(slug.split('_')[1]);
    // Names that slugify to nothing still produce a usable slug.
    expect(userSlug({ name: '???', id: 'abcdefgh' })).toBe('user_cdefgh');
    expect(parseUserSlug('nounderscore')).toBeNull();
  });

  test('GET /api/my/dashboard returns slug, bots, wallet and agent sessions', async () => {
    const user = await makeUser('Dashboard User');
    await makeBot(user.id, [], 'Dash Bot');
    await db.chatSession.create({ data: { userId: user.id, kind: 'agent', title: 'Build a shop', agent: 'bot-builder' } });

    // A real session row + cookie header, the same way the UI authenticates.
    const token = 'dash-' + user.id + '-token0000000000000000';
    await db.session.create({
      data: { userId: user.id, token, expiresAt: new Date(Date.now() + 60_000) },
    });

    const { GET } = await import('../../src/app/api/my/dashboard/route');
    const res = await GET(new Request('http://localhost/api/my/dashboard', { headers: { cookie: `nurae_session=${token}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      bots: Array<{ name: string; ownerChatId: string | null }>;
      wallet: { balanceMicros: number };
      agentSessions: Array<{ title: string }>;
    };
    expect(body.slug).toBe(userSlug({ name: 'Dashboard User', id: user.id }));
    expect(body.bots.map((b) => b.name)).toContain('Dash Bot');
    expect(body.agentSessions.map((s) => s.title)).toContain('Build a shop');
    expect(typeof body.wallet.balanceMicros).toBe('number');
  });
});
