/**
 * NURAE — built-in bots tests (Task 23): the promotion templates and
 * the runtime primitives they stand on.
 *
 *   - template integrity: catalog shape, unique ids, every template COMPILES
 *     (the drift guard — a capability change that breaks a template fails here)
 *   - growth hooks: About NURAE behavior + owner referral link baked into
 *     every welcome; community/channel buttons appear when links are given
 *   - promotion primitives: remember (set/add), draw (winner/empty), top
 *     (ranking/limit/empty), {{bot_username}}, {{key|fallback}}, templated
 *     copy/link buttons, ref_ invite credit
 *   - store: listUsersWithAttribute filters group state, surfaces names
 *   - API: POST /api/my/bots/from-template (auth, 404, ownership, hooks)
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE, telegramState } from './telegram-stub';

import { pushTestSchema } from './helpers';
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { compileBehaviors } = await import('../../src/lib/nurae/bots/behavior');
const { buildTemplateBot, isTemplateId, TEMPLATE_CATALOG } = await import('../../src/lib/nurae/bots/templates');
const { createPrismaRuntimeStore } = await import('../../src/lib/nurae/runtime/store');
const { handleBotMessage, handleBotCallback, capturingSender } = await import('../../src/lib/nurae/runtime/pipeline');
const { createUserBot } = await import('../../src/lib/nurae/bots/user-bots');
const { createUserSession } = await import('../../src/lib/nurae/auth/sessions');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const { NextResponse } = await import('next/server');

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_TOKEN = '9876543210:TplTestTokenNotRealButWellFormedAAAA';
const LINKS = { siteUrl: 'https://nurae.example', communityUrl: 'https://t.me/nurae_community', channelUrl: 'https://t.me/nurae_channel' };
const REF = 'TESTCODE23';

let userCounter = 0;

async function makeUser(): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = `t23-${userCounter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const user = await db.user.create({
    data: { name: `T23 User ${userCounter}`, email, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email };
}

interface SeedOptions {
  behaviors?: unknown[];
  username?: string;
}

async function makeBot(userIdOrOpts: string | SeedOptions = {}, maybeOpts?: SeedOptions) {
  const opts: SeedOptions = typeof userIdOrOpts === 'object' ? (userIdOrOpts ?? {}) : (maybeOpts ?? {});
  let userId = typeof userIdOrOpts === 'string' ? userIdOrOpts : '';
  if (!userId) userId = (await makeUser()).id;
  const created = await createUserBot(userId, {
    name: `TplBot ${Date.now()}-${userCounter}`,
    systemPrompt: 'You are a helpful test bot.',
    ...(opts.behaviors?.length ? { behaviors: opts.behaviors as never[] } : {}),
  });
  expect(created.bot).toBeTruthy();
  const botId = created.bot!.id;
  await db.bot.update({
    where: { id: botId },
    data: {
      telegramTokenRef: SecretManager.encrypt(STUB_TOKEN),
      provider: 'custom',
      baseUrl: `${TELEGRAM_STUB_BASE}/v1`,
      apiKeyRef: SecretManager.encrypt('stub-key'),
      telegramUsername: opts.username ?? '@tpl_test_bot',
    },
  });
  const store = createPrismaRuntimeStore(db);
  const record = await store.getBot(botId);
  expect(record).toBeTruthy();
  return { botId, record: record!, store };
}

function msg(overrides: Partial<Parameters<typeof handleBotMessage>[2]> = {}): Parameters<typeof handleBotMessage>[2] {
  return {
    chatId: '900001',
    text: 'hi',
    fromBot: false,
    fromName: 'tester',
    fromFirstName: 'Tester',
    chatType: 'private',
    ...overrides,
  };
}

function cb(overrides: Partial<Parameters<typeof handleBotCallback>[2]> = {}): Parameters<typeof handleBotCallback>[2] {
  return {
    chatId: '900001',
    callbackId: 'cb-test',
    data: 'x',
    fromBot: false,
    fromName: 'tester',
    fromFirstName: 'Tester',
    ...overrides,
  };
}

/** The callback data a compiled flow button points at. */
function flowCallback(record: { capabilities: { replies: Array<{ trigger: { type: string; value?: string } }> } }, behaviorId: string): string {
  const data = `r:b_${behaviorId}`;
  expect(record.capabilities.replies.some((r) => r.trigger.type === 'button' && r.trigger.value === data)).toBe(true);
  return data;
}

// ---------------------------------------------------------------------------
// Templates — integrity + growth hooks
// ---------------------------------------------------------------------------

describe('built-in bots — catalog and compilation', () => {
  test('the catalog ships six unique, recognizable templates', () => {
    expect(TEMPLATE_CATALOG).toHaveLength(6);
    const ids = TEMPLATE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      expect(isTemplateId(id)).toBe(true);
      const meta = TEMPLATE_CATALOG.find((t) => t.id === id)!;
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.tagline.length).toBeGreaterThan(0);
      expect(meta.highlights.length).toBeGreaterThan(0);
    }
    expect(isTemplateId('not-a-template')).toBe(false);
  });

  test('every template compiles through the real behavior compiler', () => {
    for (const meta of TEMPLATE_CATALOG) {
      const built = buildTemplateBot(meta.id, LINKS, REF);
      expect(built).toBeTruthy();
      // Throws BehaviorCompileError on drift — the guard this test exists for.
      const caps = compileBehaviors(built!.behaviors);
      expect(caps.replies.length).toBeGreaterThan(0);
    }
  });

  test('every welcome carries the owner referral link; About NURAE links the site', () => {
    for (const meta of TEMPLATE_CATALOG) {
      const built = buildTemplateBot(meta.id, LINKS, REF)!;
      const welcome = built.behaviors.find((b) => b.when.type === 'start')!;
      const text = welcome.steps.find((s) => s.type === 'message' && s.type === 'message' && 'text' in s) as { text: string };
      expect(text.text).toContain('https://nurae.example/?ref=TESTCODE23');
      const about = built.behaviors.find((b) => b.id === 'nurae_about')!;
      const flat = JSON.stringify(about);
      expect(flat).toContain('nurae.example/?ref=TESTCODE23');
      expect(flat).toContain('t.me/nurae_community');
      expect(flat).toContain('t.me/nurae_channel');
    }
  });

  test('community/channel buttons are optional — links omitted when unset', () => {
    const built = buildTemplateBot('referral-ambassador', { siteUrl: 'https://n.example' }, REF)!;
    expect(JSON.stringify(built.behaviors)).not.toContain('t.me/nurae_community');
    expect(JSON.stringify(built.behaviors)).not.toContain('t.me/nurae_channel');
  });
});

// ---------------------------------------------------------------------------
// Promotion primitives — remember / draw / top / templating / invite credit
// ---------------------------------------------------------------------------

describe('pipeline — remember, draw, top', () => {
  test('remember sets and numerically adds; later steps see fresh values', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'scoreup',
          title: 'Score',
          when: { type: 'command', command: '/scoreup' },
          steps: [
            { type: 'remember', remember: { attribute: 'score', value: '2', mode: 'add' } },
            { type: 'remember', remember: { attribute: 'entered', value: 'yes', mode: 'set' } },
            { type: 'message', text: 'Your score: {{score}} point(s). Entered: {{entered}}.' },
          ],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ text: '/scoreup' }), { store });
    const text = sender.sends.map((s) => s.text).join('\n');
    expect(text).toContain('Your score: 2 point(s). Entered: yes.');
    const state = await store.getUserState(botId, '900001');
    expect(state?.attributes).toMatchObject({ score: '2', entered: 'yes' });

    // add mode accumulates; missing attribute counts as 0
    await handleBotMessage(record, sender, msg({ text: '/scoreup', chatId: '900050' }), { store });
    const fresh = await store.getUserState(botId, '900050');
    expect(fresh?.attributes).toMatchObject({ score: '2' });
  });

  test('draw picks a winner among attribute holders; empty draw answers honestly', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'draw',
          title: 'Draw',
          when: { type: 'command', command: '/draw' },
          steps: [
            {
              type: 'draw',
              draw: {
                attribute: 'entered',
                announce: 'The winner is {{winner_name}} ({{winner_chat}}) from {{count}} entrant(s)!',
                emptyText: 'Nobody entered yet.',
              },
            },
          ],
        },
      ],
    });

    // Empty draw first.
    const emptySender = capturingSender();
    await handleBotMessage(record, emptySender, msg({ text: '/draw' }), { store });
    expect(emptySender.sends.some((s) => s.text.includes('Nobody entered yet.'))).toBe(true);

    // Two entrants (names remembered from their turns), one winner.
    await store.updateUserState(botId, '900101', { attributes: { entered: 'yes', name: 'Ada' } });
    await store.updateUserState(botId, '900102', { attributes: { entered: 'yes', name: 'Bob' } });
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ text: '/draw', chatId: '900103' }), { store });
    const text = sender.sends.map((s) => s.text).join('\n');
    expect(text).toMatch(/The winner is (Ada|Bob) \(90010[12]\) from 2 entrant\(s\)!/);
  });

  test('top ranks numeric attributes descending and respects the limit', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'board',
          title: 'Board',
          when: { type: 'command', command: '/board' },
          steps: [{ type: 'top', top: { attribute: 'score', title: 'Top players', limit: 2 } }],
        },
      ],
    });
    await store.updateUserState(record.id, '900201', { attributes: { score: '5', name: 'Ada' } });
    await store.updateUserState(record.id, '900202', { attributes: { score: '9', name: 'Bob' } });
    await store.updateUserState(record.id, '900203', { attributes: { score: '7', name: 'Cid' } });
    await store.updateUserState(record.id, '900204', { attributes: { score: 'not-a-number' } }); // filtered out
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ text: '/board', chatId: '900205' }), { store });
    const text = sender.sends.map((s) => s.text).join('\n');
    expect(text).toContain('Top players');
    expect(text.indexOf('Bob')).toBeLessThan(text.indexOf('Cid'));
    // The limit (2) cuts everyone below second place.
    expect(text).toContain('Bob');
    expect(text).toContain('Cid');
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('900204'); // non-numeric entries never rank
    expect(text).not.toContain('not-a-number');
  });

  test('top with no entries says so instead of printing an empty board', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'board',
          title: 'Board',
          when: { type: 'command', command: '/board' },
          steps: [{ type: 'top', top: { attribute: 'score', title: 'Top players', limit: 10 } }],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ text: '/board' }), { store });
    expect(sender.sends.some((s) => s.text.includes('No entries yet.'))).toBe(true);
  });
});

describe('pipeline — placeholders and templated buttons', () => {
  test('{{bot_username}} renders bare; {{key|fallback}} covers missing attributes', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'link',
          title: 'Link',
          when: { type: 'command', command: '/link' },
          steps: [
            {
              type: 'message',
              text: 'Your link: https://t.me/{{bot_username}}?start=ref_{{chat_id}} — score {{score|0}}.',
              buttons: [
                { label: 'Copy', action: { kind: 'copy', text: 'https://t.me/{{bot_username}}?start=ref_{{chat_id}}' } },
                { label: 'Site', action: { kind: 'link', url: 'https://example.com/u/{{chat_id}}' } },
              ],
            },
          ],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ text: '/link' }), { store });
    const text = sender.sends.map((s) => s.text).join('\n');
    expect(text).toContain('https://t.me/tpl_test_bot?start=ref_900001');
    expect(text).toContain('score 0.');
    const buttons = sender.sends.flatMap((s) => s.buttons ?? []).flat();
    const copyBtn = buttons.find((b) => 'copy' in b && b.copy);
    expect(copyBtn?.copy).toBe('https://t.me/tpl_test_bot?start=ref_900001');
    // Link buttons template too — per-user URLs without hand-editing.
    const urlBtn = buttons.find((b) => 'url' in b && b.url);
    expect(urlBtn?.url).toBe('https://example.com/u/900001');
  });
});

describe('pipeline — ref_ invite credit', () => {
  test('an invited arrival credits the inviter and remembers the inviter', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        { id: 'welcome', title: 'Welcome', when: { type: 'start' }, steps: [{ type: 'message', text: 'Welcome!' }] },
        {
          id: 'ref_join',
          title: 'Ref join',
          when: { type: 'payload', value: 'ref_' },
          steps: [{ type: 'message', text: 'Welcome via invite!' }],
        },
      ],
    });

    // The inviter starts the bot first.
    await handleBotMessage(record, capturingSender(), msg({ chatId: '900301', text: '/start' }), { store });
    expect((await store.getUserState(botId, '900301'))?.attributes['invites']).toBeUndefined();

    // A friend arrives through the inviter's personal link.
    const sender = capturingSender();
    await handleBotMessage(record, sender, msg({ chatId: '900302', text: '/start ref_900301' }), { store });
    expect(sender.sends.some((s) => s.text.includes('Welcome via invite!'))).toBe(true);
    expect((await store.getUserState(botId, '900301'))?.attributes['invites']).toBe('1');
    expect((await store.getUserState(botId, '900302'))?.attributes['invited_by']).toBe('900301');

    // A second invite accumulates.
    await handleBotMessage(record, capturingSender(), msg({ chatId: '900303', text: '/start ref_900301' }), { store });
    expect((await store.getUserState(botId, '900301'))?.attributes['invites']).toBe('2');

    // Self-referral changes nothing; unknown inviters are ignored.
    await handleBotMessage(record, capturingSender(), msg({ chatId: '900304', text: '/start ref_900304' }), { store });
    await handleBotMessage(record, capturingSender(), msg({ chatId: '900305', text: '/start ref_999999' }), { store });
    expect((await store.getUserState(botId, '900304'))?.attributes['invited_by']).toBeUndefined();
    expect((await store.getUserState(botId, '900305'))?.attributes['invited_by']).toBeUndefined();
    expect((await store.getUserState(botId, '900301'))?.attributes['invites']).toBe('2');
  });

  test('the referral template end to end: invite link → friend joins → leaderboard shows it', async () => {
    const built = buildTemplateBot('referral-ambassador', { siteUrl: 'https://n.example' }, 'OWNERCDE')!;
    const { botId, record, store } = await makeBot({ behaviors: built.behaviors });

    // The inviter grabs their link.
    const inviterSender = capturingSender();
    await handleBotMessage(record, inviterSender, msg({ chatId: '900401', text: '/start' }), { store });
    expect(inviterSender.sends.some((s) => s.text.includes('https://n.example/?ref=OWNERCDE'))).toBe(true);

    const linkCb = flowCallback(record, 'invite_link');
    await handleBotCallback(record, inviterSender, cb({ chatId: '900401', data: linkCb }), { store });
    const linkText = inviterSender.sends.map((s) => s.text).join('\n');
    expect(linkText).toContain('https://t.me/tpl_test_bot?start=ref_900401');
    const copyBtn = inviterSender.sends.flatMap((s) => s.buttons ?? []).flat().find((b) => 'copy' in b && b.copy);
    expect(copyBtn?.copy).toBe('https://t.me/tpl_test_bot?start=ref_900401');

    // A friend arrives through it; the inviter's counter increments.
    await handleBotMessage(record, capturingSender(), msg({ chatId: '900402', text: '/start ref_900401' }), { store });
    expect((await store.getUserState(botId, '900401'))?.attributes['invites']).toBe('1');

    // The leaderboard reflects it.
    const boardSender = capturingSender();
    const topCb = flowCallback(record, 'top_referrers');
    await handleBotCallback(record, boardSender, cb({ chatId: '900401', data: topCb }), { store });
    const boardText = boardSender.sends.map((s) => s.text).join('\n');
    expect(boardText).toContain('Top referrers');
    // The leaderboard greets the person, not the id (names are remembered).
    expect(boardText).toMatch(/1\. Tester — 1/);
  });
});

// ---------------------------------------------------------------------------
// Store — listUsersWithAttribute
// ---------------------------------------------------------------------------

describe('store — listUsersWithAttribute', () => {
  test('returns private-chat holders with values and names; group state excluded', async () => {
    const { id: userId } = await makeUser();
    const { botId, store } = await makeBot(userId);
    await store.updateUserState(botId, '900501', { attributes: { entered: 'yes', name: 'Ada' } });
    await store.updateUserState(botId, '900502', { attributes: { entered: 'yes', name: 'Bob' } });
    await store.updateUserState(botId, '-100900503', { attributes: { entered: 'yes' } }); // group — excluded
    await store.updateUserState(botId, '900504', { attributes: { other: 'x' } }); // no attribute — excluded

    const users = await store.listUsersWithAttribute(botId, 'entered');
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.chatId).sort()).toEqual(['900501', '900502']);
    expect(users.find((u) => u.chatId === '900501')).toMatchObject({ value: 'yes', name: 'Ada' });
  });
});

// ---------------------------------------------------------------------------
// API — POST /api/my/bots/from-template
// ---------------------------------------------------------------------------

describe('API — from-template instantiation', () => {
  test('creates an owned, compiled bot with growth hooks; refuses strangers', async () => {
    const { id: userId } = await makeUser();
    const session = await createUserSession(new NextResponse(), userId, 'vitest');
    const cookie = `nurae_session=${session}`;
    const route = await import('../../src/app/api/my/bots/from-template/route');

    // Unauthenticated.
    const anon = await route.POST(new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ templateId: 'giveaway' }) }));
    expect(anon.status).toBe(401);

    // Unknown template.
    const unknown = await route.POST(new Request('http://localhost/api', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'nope' }),
    }));
    expect(unknown.status).toBe(404);

    // The happy path.
    const res = await route.POST(new Request('http://localhost/api', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-forwarded-host': 'nurae.example', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ templateId: 'giveaway' }),
    }));
    expect(res.status).toBe(201);
    const { bot } = (await res.json()) as { bot: { id: string; ownerId: string; behaviors: Array<{ id: string }> } };
    expect(bot.ownerId).toBe(userId);
    expect(bot.behaviors.some((b) => b.id === 'nurae_about')).toBe(true);
    const behaviorsJson = await db.bot.findUnique({ where: { id: bot.id }, select: { behaviorsJson: true } });
    expect(behaviorsJson?.behaviorsJson).toContain('nurae.example/?ref=');
    // The link points at the forwarded host (the instance's own origin).
    expect(behaviorsJson?.behaviorsJson).toContain('https://nurae.example/?ref=');

    // A second user gets their own bot — templates never share instances.
    const { id: other } = await makeUser();
    const otherSession = await createUserSession(new NextResponse(), other, 'vitest');
    const otherRes = await route.POST(new Request('http://localhost/api', {
      method: 'POST', headers: { cookie: `nurae_session=${otherSession}`, 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'referral-ambassador' }),
    }));
    expect(otherRes.status).toBe(201);
    const { bot: otherBot } = (await otherRes.json()) as { bot: { ownerId: string; name: string } };
    expect(otherBot.ownerId).toBe(other);
    expect(otherBot.name).toBe('Referral Ambassador');
  });
});
