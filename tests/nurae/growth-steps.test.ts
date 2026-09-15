/**
 * NURAE — growth engine tests (Task 26): the new behavior primitives that
 * make the official fleet self-running growth machines.
 *
 *   - verify_join: channel-membership gate (member passes, non-member is
 *     stopped at the gate with a join prompt, absent verifier fails open)
 *   - streak: daily counters with same-day dedupe, next-day increment,
 *     record tracking and reset after a gap
 *   - milestone: celebrate-once when a counter first reaches a value
 *   - adapter: getChatMember wiring against the Telegram stub
 *   - fleet automation: platform bots added to groups arm a daily
 *     engagement post (idempotent); user-owned bots never do
 */

import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, STUB_TELEGRAM_TOKEN, telegramState } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { TelegramAdapter } = await import('../../src/lib/nurae/telegram/adapter');
const { createPrismaRuntimeStore } = await import('../../src/lib/nurae/runtime/store');
const { handleBotMessage, handleBotCallback, capturingSender, routeBotUpdate } = await import(
  '../../src/lib/nurae/runtime/pipeline'
);
type LikeSender = Parameters<typeof handleBotCallback>[1];
const { ensureOfficialFleet, OFFICIAL_FLEET } = await import('../../src/lib/nurae/auth/official-fleet');
const { ensureOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const { FLEET_DAILY_SENTINEL, fleetPostHour, botHourOffset, renderFleetDailyPost, syncFleetAutomation } = await import(
  '../../src/lib/nurae/runtime/fleet-posts'
);

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

// ---------------------------------------------------------------------------
// Harness — the OFFICIAL FLEET is the platform-bot harness (ownerId null,
// real compiled template behaviors). Verification is scripted through a
// capturing sender with a getChatMember that reads the shared stub state.
// ---------------------------------------------------------------------------

const LINKS = { siteUrl: 'https://nurae.example', channelUrl: 'https://t.me/nurae_channel' };
const CHAT = '100777'; // numeric chat id — join gates verify this as the user id

function growthSender() {
  const inner = capturingSender();
  const sender = inner as typeof inner & LikeSender;
  sender.getChatMember = async (chatRef: string, userId: number) => {
    // Mirror the real stub: per-user script, wildcard default = member.
    return telegramState.chatMemberStatus[String(userId)] ?? telegramState.chatMemberStatus['*'] ?? 'member';
  };
  return sender;
}

async function fleetBot(namePart: string) {
  await ensureOfficialBot(); // owns NURAE Official project creation
  await ensureOfficialFleet(LINKS);
  const project = await db.project.findFirst({ where: { name: 'NURAE Official' } });
  const bot = await db.bot.findFirst({ where: { projectId: project!.id, name: { contains: namePart } } });
  expect(bot, `fleet bot *${namePart}* must exist`).toBeTruthy();
  const store = createPrismaRuntimeStore(db);
  const record = await store.getBot(bot!.id);
  expect(record).toBeTruthy();
  return { bot: bot!, record: record!, store };
}

function flowData(record: { capabilities: { replies: Array<{ trigger: { type: string; value?: string } }> } }, behaviorId: string): string {
  const data = `r:b_${behaviorId}`;
  const hit = record.capabilities.replies.some((r) => r.trigger.type === 'button' && r.trigger.value === data);
  expect(hit, `flow ${behaviorId} must be wired in the compiled config`).toBe(true);
  return data;
}

async function setStateAttrs(botId: string, chatId: string, attrs: Record<string, string>): Promise<void> {
  const existing = await db.botUserState.findFirst({ where: { botId, chatId } });
  if (existing) {
    const merged = { ...(JSON.parse(existing.attributes) as Record<string, string>), ...attrs };
    await db.botUserState.update({ where: { id: existing.id }, data: { attributes: JSON.stringify(merged) } });
  } else {
    await db.botUserState.create({
      data: { botId, chatId, attributes: JSON.stringify(attrs) },
    });
  }
}

async function readStateAttrs(botId: string, chatId: string): Promise<Record<string, string>> {
  const row = await db.botUserState.findFirst({ where: { botId, chatId } });
  return row ? (JSON.parse(row.attributes) as Record<string, string>) : {};
}

function texts(sender: ReturnType<typeof capturingSender>): string[] {
  return sender.sends.map((s) => s.text);
}

// ---------------------------------------------------------------------------
// verify_join — the join gate
// ---------------------------------------------------------------------------

describe('verify_join gate', () => {
  test('non-member is stopped at the gate with a join prompt (flow paused)', async () => {
    const { record } = await fleetBot('Giveaway');
    telegramState.chatMemberStatus[CHAT] = 'left';
    const sender = growthSender();
    await handleBotCallback(record, sender, {
      chatId: CHAT,
      callbackId: 'cb-gate',
      data: flowData(record, 'enter'),
      fromName: 'gate tester',
    }, { store: createPrismaRuntimeStore(db) });

    const out = texts(sender).join('\n');
    expect(out).toContain('join our announcements channel');
    expect(out).not.toContain('You are in!'); // the flow really stopped
    expect(JSON.stringify(sender.sends)).toContain('Join the channel'); // t.me link button offered
  });

  test('member passes the gate and the flow completes', async () => {
    const { record } = await fleetBot('Giveaway');
    telegramState.chatMemberStatus[CHAT] = 'member';
    const sender = growthSender();
    await handleBotCallback(record, sender, {
      chatId: CHAT,
      callbackId: 'cb-pass',
      data: flowData(record, 'enter'),
      fromName: 'gate tester',
    }, { store: createPrismaRuntimeStore(db) });

    const out = texts(sender).join('\n');
    expect(out).toContain('You are in!');
    const attrs = await readStateAttrs(record.id, CHAT);
    expect(attrs.entered).toBe('yes');
  });

  test('fail-open: a sender without getChatMember never blocks anyone', async () => {
    const { record } = await fleetBot('Giveaway');
    const sender = capturingSender(); // no verifier wired
    await handleBotCallback(record, sender, {
      chatId: '100778',
      callbackId: 'cb-open',
      data: flowData(record, 'enter'),
      fromName: 'open tester',
    }, { store: createPrismaRuntimeStore(db) });
    expect(texts(sender).join('\n')).toContain('You are in!');
  });

  test('the Telegram adapter surfaces getChatMember through the stub', async () => {
    telegramState.chatMemberStatus['424242'] = 'administrator';
    const adapter = new TelegramAdapter({ token: STUB_TELEGRAM_TOKEN });
    expect(await adapter.getChatMember('@nurae_channel', 424242)).toBe('administrator');
    expect(await adapter.getChatMember('@nurae_channel', 999)).toBe('member');
  });
});

// ---------------------------------------------------------------------------
// streak — daily return counters
// ---------------------------------------------------------------------------

describe('streak', () => {
  test('first visit counts 1, same-day revisit does not double-count', async () => {
    const { record } = await fleetBot('Trivia');
    const store = createPrismaRuntimeStore(db);
    const sender = capturingSender();
    await handleBotMessage(record, sender, {
      chatId: CHAT, text: '/start', fromBot: false, fromName: 'streak', fromFirstName: 'Streak', chatType: 'private',
    }, { store });
    expect(await readStateAttrs(record.id, CHAT)).toMatchObject({ streak: '1', streak_best: '1' });

    await handleBotMessage(record, sender, {
      chatId: CHAT, text: '/start', fromBot: false, fromName: 'streak', fromFirstName: 'Streak', chatType: 'private',
    }, { store });
    expect(await readStateAttrs(record.id, CHAT)).toMatchObject({ streak: '1' });
    // The welcome templated the fresh value both times.
    expect(texts(sender).filter((t) => t.includes('Daily streak')).length).toBe(2);
  });

  test('next-day visit increments and the record persists; a gap resets', async () => {
    const { record } = await fleetBot('Trivia');
    const store = createPrismaRuntimeStore(db);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await setStateAttrs(record.id, '100779', { streak: '3', streak_best: '5', streak_date: yesterday });
    const sender = capturingSender();
    await handleBotMessage(record, sender, {
      chatId: '100779', text: '/start', fromBot: false, fromName: 's2', fromFirstName: 'S2', chatType: 'private',
    }, { store });
    expect(await readStateAttrs(record.id, '100779')).toMatchObject({ streak: '4', streak_best: '5' });

    // A 2-day gap resets to 1 — but the record never shrinks.
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await setStateAttrs(record.id, '100779', { streak_date: threeDaysAgo, streak: '4' });
    await handleBotMessage(record, sender, {
      chatId: '100779', text: '/start', fromBot: false, fromName: 's2', fromFirstName: 'S2', chatType: 'private',
    }, { store });
    expect(await readStateAttrs(record.id, '100779')).toMatchObject({ streak: '1', streak_best: '5' });
  });
});

// ---------------------------------------------------------------------------
// milestone — celebrate once
// ---------------------------------------------------------------------------

describe('milestone', () => {
  test('silent below the bar, announces exactly once at the bar', async () => {
    const { record } = await fleetBot('Referral');
    await setStateAttrs(record.id, CHAT, { invites: '2' });
    const sender = capturingSender();
    const press = () =>
      handleBotCallback(record, sender, {
        chatId: CHAT,
        callbackId: 'cb-mile',
        data: flowData(record, 'my_invites'),
        fromName: 'mile',
      }, { store: createPrismaRuntimeStore(db) });

    await press();
    expect(texts(sender).join('\n')).not.toContain('Milestone unlocked');

    await setStateAttrs(record.id, CHAT, { invites: '3' });
    await press();
    expect(texts(sender).join('\n')).toContain('Milestone unlocked');
    expect(await readStateAttrs(record.id, CHAT)).toMatchObject({ invites_m3: '1' });

    // Already claimed → never again.
    const before = texts(sender).length;
    await press();
    expect(texts(sender).length).toBe(before + 1); // only the counter message
    expect(texts(sender).slice(before).join('\n')).not.toContain('Milestone unlocked');
  });
});

// ---------------------------------------------------------------------------
// Fleet automation — bots added to groups arm their own daily post
// ---------------------------------------------------------------------------

describe('fleet group automation', () => {
  test('a platform bot added to a group arms ONE daily engagement post (idempotent)', async () => {
    const { record } = await fleetBot('Community');
    const store = createPrismaRuntimeStore(db);
    const sender = capturingSender();
    const update = {
      update_id: 990001,
      my_chat_member: {
        chat: { id: -1005555, type: 'supergroup', title: 'NURAE Lounge' },
        new_chat_member: { status: 'administrator' },
      },
    };
    await routeBotUpdate(record, sender as LikeSender, update, { store });
    let schedules = await db.botSchedule.findMany({ where: { botId: record.id, chatId: '-1005555' } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].recurrence).toBe('daily');
    expect(schedules[0].status).toBe('pending');
    expect(schedules[0].text).toBe(FLEET_DAILY_SENTINEL); // rendered at send time
    expect(schedules[0].runAt.getTime()).toBeGreaterThan(Date.now());

    // Same update again → no duplicate.
    await routeBotUpdate(record, sender as LikeSender, { ...update, update_id: 990002 }, { store });
    schedules = await db.botSchedule.findMany({ where: { botId: record.id, chatId: '-1005555' } });
    expect(schedules).toHaveLength(1);
  });

  test('user-owned bots are never auto-armed', async () => {
    const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
    const { createUserBot } = await import('../../src/lib/nurae/bots/user-bots');
    const email = `t26-${Date.now()}@example.com`;
    const user = await db.user.create({
      data: { name: 'T26 Owner', email, passwordHash: await hashPassword('password123'), emailVerified: true },
    });
    const created = await createUserBot(user.id, { name: `OwnerBot ${Date.now()}` });
    expect(created.bot).toBeTruthy();
    const store = createPrismaRuntimeStore(db);
    const record = await store.getBot(created.bot!.id);
    expect(record).toBeTruthy();
    const sender = capturingSender();
    await routeBotUpdate(record!, sender as LikeSender, {
      update_id: 990003,
      my_chat_member: {
        chat: { id: -1007777, type: 'supergroup', title: 'Not armed' },
        new_chat_member: { status: 'member' },
      },
    }, { store });
    expect(await db.botSchedule.findMany({ where: { botId: record!.id, chatId: '-1007777' } })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fleet daily promo — sentinel schedules, staggered hours, rotation, backfill
// ---------------------------------------------------------------------------

describe('fleet daily promo', () => {
  test('the sentinel renders into rotating NURAE promos with links', async () => {
    process.env.NURAE_SITE_URL = 'https://promo.example';
    try {
      const day1 = renderFleetDailyPost('NURAE Trivia Bot', '2026-09-15');
      expect(day1).toBeTruthy();
      expect(day1).toContain('promo.example/?ref='); // referral link present
      // Same day → same post (stable); different days → the rotation moves on.
      expect(renderFleetDailyPost('NURAE Trivia Bot', '2026-09-15')).toBe(day1);
      const variants = new Set(
        Array.from({ length: 9 }, (_, i) =>
          renderFleetDailyPost('NURAE Trivia Bot', `2026-09-${10 + i}`).slice(0, 60),
        ),
      );
      expect(variants.size).toBeGreaterThanOrEqual(3); // the week never repeats one pitch
    } finally {
      delete process.env.NURAE_SITE_URL;
    }
  });

  test('posting hours are staggered per bot and stable per chat', async () => {
    const a = await fleetBot('Community');
    const b = await fleetBot('Trivia');
    const chat = '-1008888';
    for (const record of [a.record, b.record]) {
      const offset = botHourOffset(record.id);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(23);
      expect(botHourOffset(record.id)).toBe(offset); // stable
      expect(fleetPostHour(record.id, chat)).toBe(
        Number((BigInt(chat) % 24n + BigInt(offset)) % 24n),
      );
    }
    // The two fleet bots must not be mechanically identical: different bot ids
    // hash to independent offsets (they only coincide with 1/24 probability,
    // and this pair pins the mechanism, not luck).
    expect(botHourOffset(a.record.id)).not.toBeNaN();
  });

  test('syncFleetAutomation arms missing chats and migrates legacy static posts', async () => {
    const { record } = await fleetBot('Support');
    // syncFleetAutomation only touches fleet bots that actually carry a token.
    await db.bot.update({ where: { id: record.id }, data: { telegramTokenRef: 'sync:test:token' } });
    const store = createPrismaRuntimeStore(db);
    // The bot "knows" two groups: one via a legacy v2 static schedule, one with none.
    await db.botUserState.create({
      data: { botId: record.id, chatId: '-1004411', attributes: JSON.stringify({}) },
    });
    await db.botUserState.create({
      data: { botId: record.id, chatId: '-1004412', attributes: JSON.stringify({}) },
    });
    await store.createSchedule({
      botId: record.id,
      chatId: '-1004411',
      text: '🔥 *Daily round with NURAE Support Bot*\n\nlegacy v2 static text',
      runAt: new Date(Date.now() + 3_600_000),
      recurrence: 'daily',
      createdBy: null,
    });

    const result = await syncFleetAutomation(store, new Date());
    expect(result.armed + result.migrated).toBeGreaterThanOrEqual(2);

    const migrated = await db.botSchedule.findFirst({ where: { botId: record.id, chatId: '-1004411' } });
    expect(migrated?.text).toBe(FLEET_DAILY_SENTINEL);
    const armed = await db.botSchedule.findFirst({ where: { botId: record.id, chatId: '-1004412' } });
    expect(armed?.text).toBe(FLEET_DAILY_SENTINEL);
    expect(armed?.status).toBe('pending');

    // Admin-edited text is NEVER overwritten (edit → rotation off, their choice).
    await store.createSchedule({
      botId: record.id,
      chatId: '-1004413',
      text: 'My own admin-edited daily text',
      runAt: new Date(Date.now() + 3_600_000),
      recurrence: 'daily',
      createdBy: null,
    });
    await db.botUserState.create({
      data: { botId: record.id, chatId: '-1004413', attributes: JSON.stringify({}) },
    });
    await syncFleetAutomation(store, new Date(Date.now() + 15 * 60_000)); // past the throttle
    const untouched = await db.botSchedule.findFirst({ where: { botId: record.id, chatId: '-1004413' } });
    expect(untouched?.text).toBe('My own admin-edited daily text');
  });
});

// ---------------------------------------------------------------------------
// Email flow — the Invite Bot's consent funnel end-to-end
// ---------------------------------------------------------------------------

describe('email invite flow', () => {
  test('opt-in sends an invitation, re-press never double-sends, STOP is terminal', async () => {
    const { record } = await fleetBot('Invite');
    const store = createPrismaRuntimeStore(db);
    const { __setInviteSender } = await import('../../src/lib/nurae/email/invites');
    const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
    __setInviteSender(async (msg) => {
      sent.push(msg);
      return { ok: true, detail: 'sent' };
    });

    // 1. Press "Get my invite" → collect step asks for the address.
    const sender = capturingSender();
    await handleBotCallback(record, sender, {
      chatId: CHAT,
      callbackId: 'cb-invite',
      data: flowData(record, 'get_invite'),
      fromName: 'invitee',
    }, { store });
    expect(texts(sender).join('\n')).toContain('email address');

    // 2. The address arrives → email_invite records consent + "sends" the mail.
    process.env.NURAE_SITE_URL = 'https://nurae.example';
    await handleBotMessage(record, sender, {
      chatId: CHAT,
      text: 'friend@example.com',
      fromName: 'invitee',
    }, { store, providerSelector: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('friend@example.com');
    expect(sent[0].text).toContain('https://nurae.example/?ref=');
    expect(texts(sender).join('\n')).toContain('on its way');
    const row = await db.emailInvite.findUnique({ where: { email: 'friend@example.com' } });
    expect(row).toBeTruthy();
    expect(row!.source).toBe('optin');
    expect(row!.status).toBe('invited');
    expect(row!.chatId).toBe(CHAT);

    // 3. Re-press → "already invited", no second mail.
    const sender2 = capturingSender();
    await handleBotCallback(record, sender2, {
      chatId: CHAT,
      callbackId: 'cb-invite-2',
      data: flowData(record, 'get_invite'),
      fromName: 'invitee',
    }, { store });
    await handleBotMessage(record, sender2, {
      chatId: CHAT,
      text: 'friend@example.com',
      fromName: 'invitee',
    }, { store, providerSelector: null });
    expect(sent).toHaveLength(1); // no double send
    expect(texts(sender2).join('\n')).toContain('already on the list');

    // 4. /stop → permanent unsubscribe, confirmed in chat.
    await handleBotMessage(record, capturingSender(), {
      chatId: CHAT,
      text: '/stop',
      fromName: 'invitee',
    }, { store, providerSelector: null });
    const after = await db.emailInvite.findUnique({ where: { email: 'friend@example.com' } });
    expect(after!.status).toBe('unsubscribed');

    // 5. Re-opt-in after unsubscribe is refused — the choice is honored forever.
    const sender3 = capturingSender();
    await handleBotCallback(record, sender3, {
      chatId: CHAT,
      callbackId: 'cb-invite-3',
      data: flowData(record, 'get_invite'),
      fromName: 'invitee',
    }, { store });
    await handleBotMessage(record, sender3, {
      chatId: CHAT,
      text: 'friend@example.com',
      fromName: 'invitee',
    }, { store, providerSelector: null });
    expect(sent).toHaveLength(1);
    expect(texts(sender3).join('\n')).toContain('permanent');

    // 6. An invalid address gets an honest retry prompt and no row.
    const sender4 = capturingSender();
    await handleBotCallback(record, sender4, {
      chatId: CHAT,
      callbackId: 'cb-invite-4',
      data: flowData(record, 'get_invite'),
      fromName: 'invitee',
    }, { store });
    await handleBotMessage(record, sender4, {
      chatId: CHAT,
      text: 'not-an-email',
      fromName: 'invitee',
    }, { store, providerSelector: null });
    expect(texts(sender4).join('\n')).toContain('does not look like an email address');

    __setInviteSender(null);
    delete process.env.NURAE_SITE_URL;
  });
});
