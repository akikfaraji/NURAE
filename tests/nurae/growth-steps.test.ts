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
    expect(schedules[0].text).toContain('Daily round');
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
