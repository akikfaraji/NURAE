/**
 * NURAE — the real agent system (V00.08.000): the platform Operator tier,
 * the agent docs/templates power-ups for the Bot Builder, and the operator
 * console API.
 *
 *   - platform gating: platformRequired tools refuse non-operator contexts
 *   - platform_overview / bots_list_all / platform_bot_get read the server
 *   - fleet_status / fleet_ensure / fleet_bot_update run the official fleet
 *   - platform_logs / platform_settings_get+set / customers_overview /
 *     bot_analytics — the admin's eyes and hands
 *   - user tier: docs_read (the DSL reference), template_list, template_use
 *     (instantiates a template as the user's own bot with THEIR referral code)
 *   - runOperatorTurn end-to-end with a stubbed AI provider (JSON envelope)
 *   - /api/agent/operator guarded by the admin token
 */

import { describe, expect, test, afterAll } from 'vitest';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { ensureOfficialBot, getOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const { OFFICIAL_FLEET } = await import('../../src/lib/nurae/auth/official-fleet');
const { createUserBot } = await import('../../src/lib/nurae/bots/user-bots');
const { getSiteInfo } = await import('../../src/lib/nurae/auth/settings');
const { getOrCreateInvite } = await import('../../src/lib/nurae/referral');
const { loadBehaviors } = await import('../../src/lib/nurae/bots/behavior');
const toolsMod = await import('../../src/lib/nurae/agents/tools');
const { runOperatorTurn, operatorHistory, OPERATOR_USER_ID } = await import(
  '../../src/lib/nurae/agents/operator'
);
const routeMod = await import('../../src/app/api/agent/operator/route');

// ---------------------------------------------------------------------------

function scopedEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const LINKS = { siteUrl: 'https://nurae.example' };

async function makeUser(email: string) {
  return db.user.create({ data: { email, name: email.split('@')[0], emailVerified: true } });
}

async function sessionFor(userId: string): Promise<string> {
  const created = await db.chatSession.create({
    data: { userId, kind: 'agent', agent: 'bot-builder', title: 'test' },
  });
  return created.id;
}

interface QueuedReply {
  content: string;
}

/** Stub the AI layer: queue OpenAI-compatible chat/completions responses. */
function installAiStub(): { queue: QueuedReply[]; calls: string[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const queue: QueuedReply[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes('/chat/completions')) {
      const reply = queue.shift();
      const body = {
        choices: [{ message: { role: 'assistant', content: reply?.content ?? '{"message":"stub exhausted","actions":[],"done":true}' } }],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
  return {
    queue,
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// ---------------------------------------------------------------------------
// Platform tier — gating
// ---------------------------------------------------------------------------

describe('platform tool tier', () => {
  test('platformRequired tools refuse user-scoped contexts and answer operator ones', async () => {
    const user = await makeUser('gating@example.com');
    const userCtx = { userId: user.id, sessionId: await sessionFor(user.id) };
    const denied = await toolsMod.executeTool(userCtx, 'platform_overview', {}, 1);
    expect(denied.status).toBe('error');
    expect(denied.label).toMatch(/operator/i);

    const opCtx = { userId: user.id, sessionId: 'op-session', platform: true };
    const allowed = await toolsMod.executeTool(opCtx, 'platform_overview', {}, 2);
    expect(allowed.status).toBe('ok');
    const data = allowed.data as { version: string; configured: { aiEnvKeys: Record<string, boolean> } };
    expect(data.version).toBeTruthy();
    expect(typeof data.configured.aiEnvKeys.openrouter).toBe('boolean');
  });

  test('unknown tools still error (both registries miss)', async () => {
    const user = await makeUser('unknown-tool@example.com');
    const record = await toolsMod.executeTool(
      { userId: user.id, sessionId: 's', platform: true },
      'no_such_tool',
      {},
      1,
    );
    expect(record.status).toBe('error');
    expect(record.label).toMatch(/unknown tool/i);
  });
});

// ---------------------------------------------------------------------------
// Platform tier — reads
// ---------------------------------------------------------------------------

describe('platform reads', () => {
  test('platform_overview counts users, bots, conversations and messages', async () => {
    const user = await makeUser('overview@example.com');
    const { bot } = await createUserBot(user.id, { name: 'OverviewBot' });
    const conv = await db.conversation.create({ data: { botId: bot!.id, chatId: '100' } });
    await db.message.create({ data: { conversationId: conv.id, role: 'user', content: 'hi' } });

    const record = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'platform_overview', {}, 1);
    expect(record.status).toBe('ok');
    const data = record.data as {
      bots: { total: number; platformOwned: number };
      users: number;
      messages: { total: number; last24h: number };
    };
    expect(data.users).toBeGreaterThanOrEqual(3);
    expect(data.bots.total).toBeGreaterThanOrEqual(1);
    expect(data.messages.last24h).toBeGreaterThanOrEqual(1);
  });

  test('bots_list_all marks platform vs customer bots and never leaks secrets', async () => {
    const user = await makeUser('listall@example.com');
    const { bot } = await createUserBot(user.id, { name: 'ListedBot' });
    const record = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'bots_list_all', {}, 1);
    expect(record.status).toBe('ok');
    const data = record.data as { bots: Array<{ id: string; ownedBy: string; hasTelegramToken: boolean }> };
    const mine = data.bots.find((b) => b.id === bot!.id);
    expect(mine?.ownedBy).toBe('customer');
    expect(JSON.stringify(record.data)).not.toMatch(/TokenRef|apiKeyRef|secret/i);
  });

  test('platform_bot_get returns behaviors; unknown ids fail honestly', async () => {
    const user = await makeUser('botget@example.com');
    const { bot } = await createUserBot(user.id, {
      name: 'DeepBot',
      behaviors: [{ id: 'wel', title: 'Welcome', when: { type: 'start' }, steps: [{ type: 'message', text: 'yo' }] }],
    });
    const record = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'platform_bot_get', { botId: bot!.id }, 1);
    expect(record.status).toBe('ok');
    const data = record.data as { behaviors: Array<{ id: string }>; ownedBy: string };
    expect(data.ownedBy).toBe('customer');
    expect(data.behaviors.map((b) => b.id)).toContain('wel');

    const missing = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'platform_bot_get', { botId: 'nope' }, 2);
    expect(missing.status).toBe('error');
  });

  test('bot_analytics: per-bot numbers and the busiest-bots list', async () => {
    const user = await makeUser('analytics@example.com');
    const { bot } = await createUserBot(user.id, { name: 'AnalyzigBot' });
    const c1 = await db.conversation.create({ data: { botId: bot!.id, chatId: '201' } });
    const c2 = await db.conversation.create({ data: { botId: bot!.id, chatId: '202' } });
    await db.message.create({ data: { conversationId: c1.id, role: 'user', content: 'a' } });
    await db.message.create({ data: { conversationId: c1.id, role: 'assistant', content: 'b' } });
    await db.message.create({ data: { conversationId: c2.id, role: 'user', content: 'c' } });

    const perBot = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'bot_analytics', { botId: bot!.id }, 1);
    expect(perBot.status).toBe('ok');
    const data = perBot.data as { conversations: number; messages: { total: number; last7d: number }; activeUsers7d: number };
    expect(data.conversations).toBe(2);
    expect(data.messages.total).toBe(3);
    expect(data.messages.last7d).toBe(3);

    const top = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'bot_analytics', {}, 2);
    expect(top.status).toBe('ok');
    const topData = top.data as { topBots: Array<{ botId: string }> };
    expect(topData.topBots.map((b) => b.botId)).toContain(bot!.id);
  });

  test('customers_overview lists the newest customers with bot counts', async () => {
    const user = await makeUser('customers@example.com');
    await createUserBot(user.id, { name: 'CustBot' });
    const record = await toolsMod.executeTool({ userId: user.id, sessionId: 's', platform: true }, 'customers_overview', {}, 1);
    expect(record.status).toBe('ok');
    const data = record.data as { total: number; customers: Array<{ email: string; bots: number }> };
    expect(data.total).toBeGreaterThanOrEqual(1);
    const me = data.customers.find((c) => c.email === 'customers@example.com');
    expect(me?.bots).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Platform tier — fleet
// ---------------------------------------------------------------------------

describe('platform fleet tools', () => {
  test('fleet_ensure seeds the whole fleet idempotently; fleet_status reports it', async () => {
    await ensureOfficialBot();
    const restore = scopedEnv({ NURAE_SITE_URL: 'https://nurae.example' });
    try {
      const ctx = { userId: 'op', sessionId: 's', platform: true };
      const first = await toolsMod.executeTool(ctx, 'fleet_ensure', {}, 1);
      expect(first.status).toBe('ok');
      expect((first.data as { created: number }).created).toBe(OFFICIAL_FLEET.length);

      const second = await toolsMod.executeTool(ctx, 'fleet_ensure', {}, 2);
      expect((second.data as { created: number }).created).toBe(0);

      const status = await toolsMod.executeTool(ctx, 'fleet_status', {}, 3);
      const data = status.data as Array<{ templateId: string; botId: string | null }>;
      expect(data).toHaveLength(OFFICIAL_FLEET.length);
      expect(data.every((f) => f.botId)).toBe(true);
    } finally {
      restore();
    }
  });

  test('fleet_bot_update retargets by templateId and refuses customer bots', async () => {
    const user = await makeUser('fleetupd@example.com');
    const { bot: userBot } = await createUserBot(user.id, { name: 'NotYours' });
    const ctx = { userId: user.id, sessionId: 's', platform: true };

    const ok = await toolsMod.executeTool(ctx, 'fleet_bot_update', { templateId: 'giveaway', model: 'openrouter/free' }, 1);
    expect(ok.status).toBe('ok');

    const refused = await toolsMod.executeTool(ctx, 'fleet_bot_update', { botId: userBot!.id, model: 'openrouter/free' }, 2);
    expect(refused.status).toBe('error');
    expect(refused.label).toMatch(/customer/i);
  });
});

// ---------------------------------------------------------------------------
// Platform tier — logs + settings
// ---------------------------------------------------------------------------

describe('platform logs and settings', () => {
  test('platform_logs filters by event; settings_set waits for approval then applies', async () => {
    const user = await makeUser('logs@example.com');
    const ctx = { userId: user.id, sessionId: 's', platform: true };

    const logs = await toolsMod.executeTool(ctx, 'platform_logs', { event: 'FLEET_BOT_UPDATED', limit: 10 }, 1);
    expect(logs.status).toBe('ok');
    const data = logs.data as { logs: Array<{ event: string | null }> };
    expect(data.logs.length).toBeGreaterThanOrEqual(1);
    expect(data.logs.every((l) => l.event === 'FLEET_BOT_UPDATED')).toBe(true);

    const waiting = await toolsMod.executeTool(ctx, 'platform_settings_set', { siteName: 'NURAE X', confirm: true }, 2);
    expect(waiting.status).toBe('confirm');

    const applied = await toolsMod.executeTool({ ...ctx, userConfirmed: true }, 'platform_settings_set', { siteName: 'NURAE X', confirm: true }, 3);
    expect(applied.status).toBe('ok');
    const info = await getSiteInfo();
    expect(info.siteName).toBe('NURAE X');
  });
});

// ---------------------------------------------------------------------------
// User tier — docs, templates
// ---------------------------------------------------------------------------

describe('user tier power-ups', () => {
  test('docs_read returns the full DSL reference; template_list lists the catalog', async () => {
    const user = await makeUser('docs@example.com');
    const ctx = { userId: user.id, sessionId: 's' };
    const growth = await toolsMod.executeTool(ctx, 'docs_read', { topic: 'growth' }, 1);
    const text = (growth.data as { text: string }).text;
    expect(text).toContain('verify_join');
    expect(text).toContain('streak');
    expect(text).toContain('email_invite');

    const behaviors = await toolsMod.executeTool(ctx, 'docs_read', { topic: 'behaviors' }, 2);
    expect((behaviors.data as { text: string }).text).toContain('member_joined');

    const list = await toolsMod.executeTool(ctx, 'template_list', {}, 3);
    expect((list.data as unknown[]).length).toBe(OFFICIAL_FLEET.length);
  });

  test('template_use instantiates a template as the user\u2019s own bot with their referral code', async () => {
    const user = await makeUser('template@example.com');
    const record = await toolsMod.executeTool(
      { userId: user.id, sessionId: 's', links: LINKS },
      'template_use',
      { templateId: 'giveaway', name: 'My Giveaway' },
      1,
    );
    expect(record.status).toBe('ok');
    const data = record.data as { botId: string; behaviors: number };
    expect(data.behaviors).toBeGreaterThan(0);

    const row = await db.bot.findUnique({ where: { id: data.botId } });
    expect(row?.ownerId).toBe(user.id);
    expect(row?.name).toBe('My Giveaway');
    const behaviors = loadBehaviors({ behaviorsJson: row?.behaviorsJson ?? null });
    expect(behaviors.length).toBeGreaterThan(0);
    const { code } = await getOrCreateInvite(user.id);
    expect(row?.behaviorsJson).toContain(code);

    const unknown = await toolsMod.executeTool({ userId: user.id, sessionId: 's', links: LINKS }, 'template_use', { templateId: 'nope' }, 2);
    expect(unknown.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// The operator loop + API
// ---------------------------------------------------------------------------

describe('operator agent loop', () => {
  test('runOperatorTurn executes platform tools and persists the conversation', async () => {
    await ensureOfficialBot();
    const official = await getOfficialBot();
    expect(official).toBeTruthy();
    await db.bot.update({
      where: { id: official!.id },
      data: { provider: 'custom', model: 'stub', baseUrl: 'http://stub/v1' },
    });
    const restoreKey = scopedEnv({ CUSTOM_API_KEY: 'stub-key' });

    const ai = installAiStub();
    try {
      ai.queue.push({ content: JSON.stringify({ message: '', actions: [{ tool: 'platform_overview', args: {} }], done: false }) });
      ai.queue.push({ content: JSON.stringify({ message: 'All systems nominal — bots and fleet are alive.', actions: [], done: true }) });

      const result = await runOperatorTurn({ userText: 'How is the platform doing?' });
      expect(result.error).toBeUndefined();
      expect(result.reply).toContain('nominal');
      expect(result.activity).toHaveLength(1);
      expect(result.activity[0].tool).toBe('platform_overview');
      expect(result.activity[0].status).toBe('ok');
      expect(ai.calls.some((u) => u.includes('/chat/completions'))).toBe(true);

      const history = await operatorHistory();
      expect(history.entries.some((e) => e.role === 'user' && e.content.includes('How is the platform'))).toBe(true);
      expect(history.entries.some((e) => e.role === 'assistant' && e.activity?.length)).toBe(true);

      const steps = await db.agentStep.findMany({ where: { session: { userId: OPERATOR_USER_ID } } });
      expect(steps.some((s) => s.tool === 'platform_overview' && s.status === 'ok')).toBe(true);
    } finally {
      ai.restore();
      restoreKey();
    }
  });

  test('GET /api/agent/operator bootstraps the console; POST rejects empty turns', async () => {
    await ensureOfficialBot();
    const getRes = await routeMod.GET(new Request('http://localhost/api/agent/operator'));
    expect(getRes.status).toBe(200);
    const payload = (await getRes.json()) as { sessionId: string; tools: Array<{ name: string }>; entries: unknown[] };
    expect(payload.sessionId).toBeTruthy();
    expect(payload.tools.length).toBeGreaterThanOrEqual(11);
    expect(payload.tools.some((t) => t.name === 'fleet_ensure')).toBe(true);

    const empty = await routeMod.POST(
      new Request('http://localhost/api/agent/operator', { method: 'POST', body: JSON.stringify({ text: '' }) }),
    );
    expect(empty.status).toBe(422);
  });
});

afterAll(() => {
  /* fetch stubs restore themselves; nothing global to undo */
});
