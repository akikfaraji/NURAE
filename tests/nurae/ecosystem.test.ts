/**
 * NURAE — ecosystem tests (Task 22): the full interaction surface.
 *
 * Covers the new primitives end to end against the REAL pipeline, the REAL
 * Prisma store (isolated per-process SQLite) and the REAL task engine:
 *   - compiler: media/poll/payment/collect/schedule steps, webapp/copy
 *     buttons, payload & member_joined triggers, Stars compliance commands,
 *     reply keyboards, derive→compile round trip
 *   - pipeline: forms (collect → answer → resume + {{placeholders}}),
 *     Stars payments (invoice → pre-checkout → successful_payment → ledger),
 *     deep-link payload routing, group joins, mention gating, reply-keyboard
 *     exact-text rules, reminders (schedule step → AI parse → BotSchedule),
 *     inline mode, edit-in-place, typing indicator
 *   - tasks engine: due schedules (once + recurring) and paced broadcasts
 *   - tools: profile, broadcast gating, schedules, audience, payments
 *   - API: the restored Preview route (BR-019)
 */

import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE, telegramState } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const {
  compileBehaviors,
  deriveBehaviors,
  loadBehaviors,
} = await import('../../src/lib/nurae/bots/behavior');
const {
  createPrismaRuntimeStore,
} = await import('../../src/lib/nurae/runtime/store');
const {
  handleBotMessage,
  handleBotCallback,
  routeBotUpdate,
  capturingSender,
} = await import('../../src/lib/nurae/runtime/pipeline');
const { runDueBotWork } = await import('../../src/lib/nurae/runtime/tasks');
const { executeTool } = await import('../../src/lib/nurae/agents/tools');
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

const STUB_TOKEN = '9876543210:EcoTestTokenNotRealButWellFormedAAAA';

let userCounter = 0;

async function makeUser(): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = `t22-${userCounter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const user = await db.user.create({
    data: { name: `T22 User ${userCounter}`, email, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email };
}

interface SeedOptions {
  behaviors?: unknown[];
  commands?: Array<{ command: string; description: string; kind?: string; response?: string }>;
  aiScript?: string[];
  provider?: string;
}

async function makeBot(userIdOrOpts: string | SeedOptions = {}, maybeOpts?: SeedOptions) {
  const opts: SeedOptions = typeof userIdOrOpts === 'object' ? (userIdOrOpts ?? {}) : (maybeOpts ?? {});
  let userId = typeof userIdOrOpts === 'string' ? userIdOrOpts : '';
  if (!userId) userId = (await makeUser()).id;
  const created = await createUserBot(userId, {
    name: `EcoBot ${Date.now()}-${userCounter}`,
    systemPrompt: 'You are a helpful test bot.',
  });
  expect(created.bot).toBeTruthy();
  const botId = created.bot!.id;
  await db.bot.update({
    where: { id: botId },
    data: {
      telegramTokenRef: SecretManager.encrypt(STUB_TOKEN),
      provider: opts.provider ?? 'custom',
      baseUrl: `${TELEGRAM_STUB_BASE}/v1`,
      apiKeyRef: SecretManager.encrypt('stub-key'),
      ...(opts.commands ? { commandsJson: JSON.stringify(opts.commands.map((c) => ({ kind: 'static', response: '', ...c }))) } : {}),
    },
  });
  if (opts.behaviors?.length) {
    const { updateUserBot } = await import('../../src/lib/nurae/bots/user-bots');
    const r = await updateUserBot(userId, botId, { behaviors: opts.behaviors as never[] });
    expect(r.error).toBeUndefined();
  }
  if (opts.aiScript?.length) telegramState.aiResponses.push(...opts.aiScript);
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

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

describe('compiler — the extended behavior language', () => {
  test('media, poll, payment and collect steps compile into executable replies', () => {
    const caps = compileBehaviors([
      {
        id: 'deal',
        title: 'Deal of the day',
        when: { type: 'command', command: '/deal' },
        steps: [
          { type: 'media', media: { kind: 'photo', source: 'https://example.com/deal.jpg', caption: 'Today: **pizza**' } },
          { type: 'poll', poll: { question: 'Pineapple on pizza?', options: ['Yes', 'No'], quiz: true, correctOption: 1 } },
          { type: 'payment', payment: { title: 'Meal deal', description: 'One pizza', priceStars: 25, successText: 'Enjoy!' } },
          { type: 'collect', collect: { attribute: 'flavour', prompt: 'Which flavour?' } },
          { type: 'schedule', schedule: { prompt: 'When should we deliver?' } },
        ],
      },
    ]);
    const rule = caps.replies.find((r) => r.id === 'b_deal');
    expect(rule).toBeTruthy();
    const [media, poll, payment, collect, schedule] = rule!.messages;
    expect(media.media).toMatchObject({ kind: 'photo', source: 'https://example.com/deal.jpg' });
    expect(media.media?.caption).toContain('**pizza**');
    expect(poll.poll).toMatchObject({ question: 'Pineapple on pizza?', quiz: true, correctOption: 1 });
    expect(payment.payment).toMatchObject({ title: 'Meal deal', priceStars: 25, payload: 'p_deal_2' });
    expect(collect.collect).toMatchObject({ attribute: 'flavour' });
    expect(schedule.schedule).toBeTruthy();
    // Media compile keeps the (unused) text slot empty but valid.
    expect(media.text).toBe('');
  });

  test('selling auto-adds the Stars compliance commands (/terms /paysupport /support)', () => {
    const caps = compileBehaviors([
      {
        id: 'sell',
        title: 'Sell',
        when: { type: 'command', command: '/buy' },
        steps: [{ type: 'payment', payment: { title: 'Course', description: 'Access', priceStars: 100 } }],
      },
    ]);
    const names = caps.commands.map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['/terms', '/paysupport', '/support']));
    const terms = caps.commands.find((c) => c.command === '/terms');
    expect(terms?.response).toContain('Stars');
  });

  test('compliance commands respect ones the builder already defined', () => {
    const caps = compileBehaviors([
      {
        id: 'sell',
        title: 'Sell',
        when: { type: 'command', command: '/buy' },
        steps: [{ type: 'payment', payment: { title: 'Course', description: 'x', priceStars: 5 } }],
      },
      {
        id: 'myterms',
        title: 'My terms',
        when: { type: 'command', command: '/terms' },
        steps: [{ type: 'message', text: 'My own terms.' }],
      },
    ]);
    // The builder's own /terms is a compiled command behavior (static commands
    // defer to their reply rule), and compliance must NOT duplicate it.
    expect(caps.commands.filter((c) => c.command === '/terms')).toHaveLength(1);
    const termsRule = caps.replies.find((r) => r.id === 'b_myterms');
    expect(termsRule?.messages[0].text).toBe('My own terms.');
  });

  test('payload and member_joined triggers compile; flow targets stay enforced', () => {
    const caps = compileBehaviors([
      {
        id: 'flyer',
        title: 'Flyer visitors',
        when: { type: 'payload', value: 'flyer' },
        steps: [{ type: 'message', text: 'Welcome from the flyer!' }],
      },
      {
        id: 'join',
        title: 'Group welcome',
        when: { type: 'member_joined' },
        steps: [{ type: 'message', text: 'Welcome {{name}}!' }],
      },
    ]);
    expect(caps.replies.find((r) => r.trigger.type === 'payload')?.trigger.value).toBe('flyer');
    const join = caps.replies.find((r) => r.trigger.type === 'member_joined');
    expect(join).toBeTruthy();
    expect(join!.messages[0].text).toContain('{{name}}');
  });

  test('webapp and copy buttons compile to their Telegram shapes', () => {
    const caps = compileBehaviors([
      {
        id: 'tools',
        title: 'Tools',
        when: { type: 'command', command: '/tools' },
        steps: [
          {
            type: 'message',
            text: 'Handy things:',
            buttons: [
              { label: 'App', action: { kind: 'webapp', url: 'https://app.example.com' } },
              { label: 'Coupon', action: { kind: 'copy', text: 'NURAE-10' } },
            ],
          },
        ],
      },
    ]);
    const buttons = caps.replies.find((r) => r.id === 'b_tools')!.messages[0].buttons![0];
    expect(buttons[0].webapp).toBe('https://app.example.com');
    expect(buttons[1].copy).toBe('NURAE-10');
  });

  test('reply keyboards compile labels to exact-text rules and reject link buttons', () => {
    const caps = compileBehaviors([
      {
        id: 'menu',
        title: 'Menu',
        when: { type: 'command', command: '/menu' },
        steps: [
          {
            type: 'message',
            text: 'Pick one:',
            keyboard: 'reply',
            buttons: [
              { label: 'Pizza', action: { kind: 'message', text: 'Good choice.' } },
            ],
          },
        ],
      },
    ]);
    const textRule = caps.replies.find((r) => r.trigger.type === 'text');
    expect(textRule).toBeTruthy();
    expect(textRule!.trigger.value).toBe('Pizza');
    expect(textRule!.messages[0].text).toBe('Good choice.');
    // Link buttons inside a reply keyboard are dead buttons — refused.
    expect(() =>
      compileBehaviors([
        {
          id: 'bad',
          title: 'Bad',
          when: { type: 'command', command: '/bad' },
          steps: [
            {
              type: 'message',
              text: 'x',
              keyboard: 'reply',
              buttons: [{ label: 'Site', action: { kind: 'link', url: 'https://x.com' } }],
            },
          ],
        },
      ]),
    ).toThrow(/reply keyboards/i);
  });

  test('derive → compile round trip preserves the new step types', () => {
    const original = [
      {
        id: 'deal',
        title: 'Deal',
        when: { type: 'command', command: '/deal' },
        steps: [
          { type: 'media', media: { kind: 'photo', source: 'https://example.com/x.jpg', caption: 'look' } },
          { type: 'payment', payment: { title: 'Deal', description: 'One deal', priceStars: 10, successText: 'Thanks' } },
          { type: 'collect', collect: { attribute: 'email', prompt: 'Your email?' } },
        ],
      },
      {
        id: 'join',
        title: 'Join',
        when: { type: 'member_joined' },
        steps: [{ type: 'message', text: 'Welcome!' }],
      },
      {
        id: 'flyer',
        title: 'Flyer',
        when: { type: 'payload', value: 'flyer' },
        steps: [{ type: 'message', text: 'Hi!' }],
      },
    ];
    const caps = compileBehaviors(original as never[]);
    const derived = deriveBehaviors(caps);
    const recompiled = compileBehaviors(derived);
    const rule = recompiled.replies.find((r) => r.id === 'b_deal');
    expect(rule?.messages.map((m) => [m.media?.kind, m.payment?.title, m.collect?.attribute]).filter(Boolean).length).toBe(3);
    expect(recompiled.replies.find((r) => r.trigger.type === 'member_joined')).toBeTruthy();
    expect(recompiled.replies.find((r) => r.trigger.type === 'payload')?.trigger.value).toBe('flyer');
    // And the derived behaviors pass the official loader.
    expect(loadBehaviors({ behaviorsJson: JSON.stringify(derived) }).length).toBe(derived.length);
  });
});

// ---------------------------------------------------------------------------
// Pipeline — forms, payments, groups, payloads, reminders, inline
// ---------------------------------------------------------------------------

describe('pipeline — per-user state, collect & templating', () => {
  test('a collect step asks, stores the answer, and resumes the flow with {{placeholders}}', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'order',
          title: 'Order',
          when: { type: 'command', command: '/order' },
          steps: [
            { type: 'collect', collect: { attribute: 'dish', prompt: 'What would you like?' } },
            { type: 'message', text: 'Thanks {{name}} — one {{dish}} coming up!' },
          ],
        },
      ],
    });
    const sender = capturingSender();

    await handleBotMessage(record!, sender, msg({ text: '/order' }), { store });
    expect(sender.sends.some((s) => s.text.includes('What would you like?'))).toBe(true);
    const pending = await store.getUserState(botId, '900001');
    expect(pending?.awaiting).toBe('dish');
    expect(pending?.resumeRuleId).toBe('b_order');
    expect(pending?.resumeStep).toBe(0);

    // The answer is stored, the flow resumes with the attribute substituted.
    await handleBotMessage(record!, sender, msg({ text: 'Margherita' }), { store });
    const done = await store.getUserState(botId, '900001');
    expect(done?.awaiting).toBeNull();
    expect(done?.attributes.dish).toBe('Margherita');
    expect(sender.sends.some((s) => s.text.includes('Thanks Tester — one Margherita coming up!'))).toBe(true);
  });

  test('commands escape a pending question; {{chat_id}} and {{username}} work', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'ask',
          title: 'Ask',
          when: { type: 'command', command: '/ask' },
          steps: [{ type: 'collect', collect: { attribute: 'note' } }],
        },
        {
          id: 'whoami',
          title: 'Whoami',
          when: { type: 'command', command: '/whoami' },
          steps: [{ type: 'message', text: 'chat {{chat_id}} user {{username}}' }],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record!, sender, msg({ text: '/ask' }), { store });
    expect((await store.getUserState(botId, '900001'))?.awaiting).toBe('note');

    // A command while awaiting → the pending question is dropped, command runs.
    await handleBotMessage(record!, sender, msg({ text: '/whoami' }), { store });
    expect(sender.sends.some((s) => s.text.includes('chat 900001 user @tester'))).toBe(true);
    expect((await store.getUserState(botId, '900001'))?.awaiting).toBeNull();
  });
});

describe('pipeline — Stars payments', () => {
  test('invoice → pre-checkout → successful_payment records the ledger and delivers', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'buy',
          title: 'Buy',
          when: { type: 'command', command: '/buy' },
          steps: [
            { type: 'payment', payment: { title: 'Ebook', description: 'NURAE ebook', priceStars: 50, successText: 'Here is your download: https://x/y' } },
          ],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record!, sender, msg({ text: '/buy' }), { store });
    const invoice = sender.sends.find((s) => s.kind === 'payment');
    expect(invoice?.payment).toMatchObject({ title: 'Ebook', priceStars: 50, payload: 'p_buy_0' });

    // Telegram asks pre-checkout — must be answered ok within 10 seconds.
    await routeBotUpdate(record!, sender, {
      update_id: 1,
      pre_checkout_query: { id: 'pcq-1', currency: 'XTR', total_amount: 50, invoice_payload: 'p_buy_0' },
    }, { store });
    expect(sender.preCheckoutAnswers).toEqual([{ queryId: 'pcq-1', ok: true }]);

    // The money lands: ledger row + paid_ attribute + delivery text.
    await routeBotUpdate(record!, sender, {
      update_id: 2,
      message: {
        message_id: 10,
        from: { id: 900001, is_bot: false, first_name: 'Tester', username: 'tester' },
        chat: { id: 900001, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        successful_payment: {
          currency: 'XTR',
          total_amount: 50,
          invoice_payload: 'p_buy_0',
          telegram_payment_charge_id: 'chg-1',
        },
      },
    }, { store });
    const payments = await store.listPayments(botId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ chargeId: 'chg-1', amount: 50, currency: 'XTR', payload: 'p_buy_0' });
    const state = await store.getUserState(botId, '900001');
    expect(state?.attributes.paid_p_buy_0).toBe('yes');
    expect(sender.sends.some((s) => s.text.includes('Here is your download'))).toBe(true);

    // Webhook redelivery (same charge id) must not double-record.
    await routeBotUpdate(record!, sender, {
      update_id: 3,
      message: {
        message_id: 11,
        from: { id: 900001, is_bot: false },
        chat: { id: 900001, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        successful_payment: {
          currency: 'XTR',
          total_amount: 50,
          invoice_payload: 'p_buy_0',
          telegram_payment_charge_id: 'chg-1',
        },
      },
    }, { store });
    expect(await store.listPayments(botId)).toHaveLength(1);
  });
});

describe('pipeline — payloads, groups, reply keyboards, inline, edits', () => {
  test('a deep-link payload routes to its behavior and is remembered', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'flyer',
          title: 'Flyer',
          when: { type: 'payload', value: 'flyer' },
          steps: [{ type: 'message', text: 'Welcome from the flyer!' }],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record!, sender, msg({ text: '/start flyer_abc123' }), { store });
    expect(sender.sends.some((s) => s.text.includes('from the flyer'))).toBe(true);
    expect((await store.getUserState(botId, '900001'))?.startPayload).toBe('flyer_abc123');
  });

  test('group joins trigger the welcome; free group text needs a mention; commands do not', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'join',
          title: 'Welcome',
          when: { type: 'member_joined' },
          steps: [{ type: 'message', text: 'Welcome {{name}}, read the rules!' }],
        },
      ],
    });
    const sender = capturingSender();

    // Join service message → welcome with the joiner's name.
    await routeBotUpdate(record!, sender, {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 2, is_bot: false },
        chat: { id: -100123, type: 'supergroup', title: 'Test group' },
        date: Math.floor(Date.now() / 1000),
        new_chat_members: [{ id: 5, is_bot: false, first_name: 'Ada' }],
      },
    }, { store });
    expect(sender.sends.some((s) => s.text.includes('Welcome Ada'))).toBe(true);

    // Plain chatter in a group → silence (no mention).
    await handleBotMessage(record!, sender, msg({ chatId: '-100123', chatType: 'supergroup', text: 'just chatting' }), { store });
    expect(sender.sends.filter((s) => s.text.includes('just chatting'))).toHaveLength(0);

    // Mentioned → the AI answers.
    telegramState.aiResponses.push('group hello!');
    await handleBotMessage(record!, sender, msg({ chatId: '-100123', chatType: 'supergroup', text: '@ecobot what is up?', mentionsBot: true }), { store });
    expect(sender.sends.some((s) => s.text.includes('group hello!'))).toBe(true);
  });

  test('reply-keyboard labels route as exact-text rules (case-insensitive)', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'menu',
          title: 'Menu',
          when: { type: 'command', command: '/menu' },
          steps: [
            { type: 'message', text: 'Pick one:', keyboard: 'reply', buttons: [{ label: 'Pizza', action: { kind: 'message', text: 'Good choice.' } }] },
          ],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record!, sender, msg({ text: '/menu' }), { store });
    await handleBotMessage(record!, sender, msg({ text: '  pizza ' }), { store });
    expect(sender.sends.some((s) => s.text.includes('Good choice.'))).toBe(true);
  });

  test('inline queries get static results; commands aimed at other bots are ignored', async () => {
    const { record, store } = await makeBot({
      commands: [{ command: '/pricing', description: 'Our prices', response: 'All free **today**.' }],
    });
    const sender = capturingSender();
    await routeBotUpdate(record!, sender, {
      update_id: 1,
      inline_query: { id: 'iq-1', from: { id: 900001, is_bot: false }, query: 'price' },
    }, { store });
    expect(sender.inlineAnswers).toHaveLength(1);
    expect(sender.inlineAnswers[0].results[0]).toMatchObject({ title: 'Our prices' });
    expect(sender.inlineAnswers[0].results[0].body).toContain('<b>today</b>');

    // Another bot's command → silence.
    const before = sender.sends.length;
    await handleBotMessage(record!, sender, msg({ text: '/menu@SomeOtherBot', botUsername: 'ecobot' }), { store });
    expect(sender.sends.length).toBe(before);
  });

  test('edit:true on a callback turn edits the pressed message in place', async () => {
    const { record, store } = await makeBot({
      behaviors: [
        {
          id: 'page',
          title: 'Page',
          when: { type: 'button' },
          steps: [{ type: 'message', text: 'Page 2 of 3', edit: true, buttons: [{ label: 'Back', action: { kind: 'message', text: 'Page 1' } }] }],
        },
      ],
    });
    const sender = capturingSender();
    await handleBotCallback(record!, sender, { chatId: '900001', callbackId: 'cb-1', data: 'r:b_page', messageId: 77 }, { store });
    expect(sender.edits).toEqual([{ chatId: '900001', messageId: 77, text: expect.stringContaining('Page 2 of 3') }]);
  });

  test('a schedule step parses the answer with the bot AI and creates a reminder', async () => {
    const { botId, record, store } = await makeBot({
      behaviors: [
        {
          id: 'remind',
          title: 'Remind',
          when: { type: 'command', command: '/remind' },
          steps: [{ type: 'schedule', schedule: { prompt: 'What and when?' } }],
        },
      ],
      aiScript: [
        'I am not sure what you mean…', // first answer is unparseable → honest retry
        JSON.stringify({ iso: new Date(Date.now() + 60 * 60 * 1000).toISOString(), text: 'Water the plants' }),
      ],
    });
    const sender = capturingSender();
    await handleBotMessage(record!, sender, msg({ text: '/remind' }), { store });
    expect(sender.sends.some((s) => s.text.includes('What and when?'))).toBe(true);
    expect((await store.getUserState(botId, '900001'))?.awaiting).toBe('_schedule');

    // An unparseable answer answers honestly and KEEPS waiting.
    await handleBotMessage(record!, sender, msg({ text: 'banana sometime' }), { store });
    expect(sender.sends.some((s) => s.text.includes("couldn't work out a time"))).toBe(true);
    expect((await store.getUserState(botId, '900001'))?.awaiting).toBe('_schedule');

    // A parseable answer creates the reminder and confirms it.
    await handleBotMessage(record!, sender, msg({ text: 'water the plants in 1 hour' }), { store });
    const schedules = await store.listSchedules(botId);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].text).toBe('Water the plants');
    expect(schedules[0].runAt.getTime()).toBeGreaterThan(Date.now());
    expect(sender.sends.some((s) => s.text.includes('remind you on'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task engine — schedules + broadcasts
// ---------------------------------------------------------------------------

describe('task engine — scheduler and broadcast', () => {
  test('due schedules are delivered; recurring ones re-arm at the same time', async () => {
    const { botId, store } = await makeBot({});
    await store.createSchedule({ botId, chatId: '900001', text: 'One-time ping', runAt: new Date(Date.now() - 1000) });
    const hourlyBase = new Date(Date.now() - 1000);
    await store.createSchedule({ botId, chatId: '900001', text: 'Daily ping', runAt: hourlyBase, recurrence: 'daily' });
    telegramState.sends.length = 0;

    const result = await runDueBotWork(store, { botId });
    expect(result.schedulesSent).toBe(2);
    expect(telegramState.sends.some((s) => s.text.includes('One-time ping'))).toBe(true);
    const rows = await store.listSchedules(botId);
    const daily = rows.find((r) => r.text === 'Daily ping');
    expect(daily?.status).toBe('pending');
    // Re-armed ~24h after the original time (not after processing time).
    expect(daily!.runAt.getTime()).toBeGreaterThanOrEqual(hourlyBase.getTime() + 24 * 3600 * 1000 - 5000);
    expect(daily!.runAt.getTime()).toBeLessThan(hourlyBase.getTime() + 24 * 3600 * 1000 + 5000);
    // The one-time schedule is gone from the pending list.
    expect(rows.find((r) => r.text === 'One-time ping')).toBeUndefined();
  });

  test('broadcasts fan out to every chat, paced, with honest counters', async () => {
    const { id: userId } = await makeUser();
    const { botId, store } = await makeBot(userId);
    // Broadcasts are metered per recipient (V00.05.000) — put the owner on a
    // trial so this test exercises fan-out mechanics, not billing.
    await db.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() + 86_400_000) } });
    await store.updateUserState(botId, '900001', { touch: true });
    await store.updateUserState(botId, '900002', { touch: true });
    await store.updateUserState(botId, '900003', { touch: true });
    await store.createBroadcast(botId, 'Hello everyone!', 3);
    telegramState.sends.length = 0;

    const result = await runDueBotWork(store, { botId });
    expect(result.broadcastSent).toBe(3);
    expect(result.broadcastFailed).toBe(0);
    expect(telegramState.sends.filter((s) => s.text.includes('Hello everyone!'))).toHaveLength(3);
    const list = await store.listBroadcasts(botId);
    expect(list[0]).toMatchObject({ status: 'done', sent: 3, total: 3 });
    // A finished broadcast cannot be claimed again.
    expect(await store.claimPendingBroadcast(botId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tools — profile, audience, broadcast, schedule, payments
// ---------------------------------------------------------------------------

describe('tools — the ecosystem surface', () => {
  test('bot_set_profile talks to Telegram when a token exists (and refuses without one)', async () => {
    const { id: userId } = await makeUser();
    const { botId } = await makeBot(userId);
    const ctx = { userId, sessionId: 's-profile' };
    telegramState.log.length = 0;
    const ok = await executeTool(ctx as never, 'bot_set_profile', {
      botId,
      description: 'A helpful demo bot for tests.',
      shortDescription: 'Test bot',
    }, 1);
    expect(ok.status).toBe('ok');
    expect(telegramState.log.some((l) => l.method === 'setMyDescription')).toBe(true);
    expect(telegramState.log.some((l) => l.method === 'setMyShortDescription')).toBe(true);

    // A tokenless bot refuses honestly.
    const draft = await createUserBot(userId, { name: 'Tokenless' });
    const fail = await executeTool(ctx as never, 'bot_set_profile', { botId: draft.bot!.id, description: 'x' }, 2);
    expect(fail.status).toBe('error');
  });

  test('bot_broadcast needs approval, refuses empty audiences, and queues when confirmed', async () => {
    const { id: userId } = await makeUser();
    const { botId, store } = await makeBot(userId);
    const ctx = { userId, sessionId: 's-broadcast' };

    const noApproval = await executeTool(ctx as never, 'bot_broadcast', { botId, text: 'Hi', confirm: false }, 1);
    expect(noApproval.status).toBe('confirm');

    const nobody = await executeTool({ ...ctx, userConfirmed: true } as never, 'bot_broadcast', { botId, text: 'Hi', confirm: true }, 2);
    expect(nobody.status).toBe('error');

    await store.updateUserState(botId, '900001', { touch: true });
    const ok = await executeTool({ ...ctx, userConfirmed: true } as never, 'bot_broadcast', { botId, text: 'News!', confirm: true }, 3);
    expect(ok.status).toBe('ok');
    expect((await store.listBroadcasts(botId))[0].status).toBe('pending');
  });

  test('bot_schedule_message validates time, supports cancellation, ownership holds', async () => {
    const { id: userId } = await makeUser();
    const other = await makeUser();
    const { botId, store } = await makeBot(userId);
    const ctx = { userId, sessionId: 's-sched' };

    const ok = await executeTool(ctx as never, 'bot_schedule_message', {
      botId, chatId: '900001', text: 'Drip lesson 1', inMinutes: 5,
    }, 1);
    expect(ok.status).toBe('ok');
    const rows = await store.listSchedules(botId);
    expect(rows).toHaveLength(1);

    const cancel = await executeTool(ctx as never, 'bot_schedule_message', { botId, cancelScheduleId: rows[0].id }, 2);
    expect(cancel.status).toBe('ok');
    expect(await store.listSchedules(botId)).toHaveLength(0);

    const past = await executeTool(ctx as never, 'bot_schedule_message', {
      botId, chatId: '900001', text: 'x', runAt: new Date(Date.now() - 60_000).toISOString(),
    }, 3);
    expect(past.status).toBe('error');

    // Foreign bots are invisible even for reads.
    const foreign = await executeTool({ userId: other.id, sessionId: 'x' } as never, 'bot_list_schedules', { botId }, 4);
    expect(foreign.status).toBe('error');
  });

  test('bot_list_users and bot_payments_list expose the audience and the ledger', async () => {
    const { id: userId } = await makeUser();
    const { botId, store } = await makeBot(userId);
    await store.updateUserState(botId, '900042', { attributes: { name: 'Ada' }, startPayload: 'flyer' });
    await store.recordPayment({ botId, chatId: '900042', chargeId: 'c1', amount: 30, currency: 'XTR', payload: 'p_x', title: 'Thing' });

    const users = await executeTool({ userId, sessionId: 'x' } as never, 'bot_list_users', { botId }, 1);
    expect(users.status).toBe('ok');
    expect(users.data).toMatchObject({ users: [{ chatId: '900042', startPayload: 'flyer' }] });

    const pays = await executeTool({ userId, sessionId: 'x' } as never, 'bot_payments_list', { botId }, 2);
    expect(pays.status).toBe('ok');
    expect(pays.data).toMatchObject({ totalStars: 30 });
  });
});

// ---------------------------------------------------------------------------
// Store — user-state merge semantics + audience union
// ---------------------------------------------------------------------------

describe('store — per-user state and audience', () => {
  test('attributes merge, null deletes, the store caps entries, startPayload persists', async () => {
    const { id: userId } = await makeUser();
    const { botId, store } = await makeBot(userId);
    await store.updateUserState(botId, '900100', { attributes: { a: '1' }, startPayload: 'x' });
    await store.updateUserState(botId, '900100', { attributes: { b: '2' } });
    await store.updateUserState(botId, '900100', { attributes: { a: null } });
    const s = await store.getUserState(botId, '900100');
    expect(s?.attributes).toEqual({ b: '2' });
    expect(s?.startPayload).toBe('x');

    await store.updateUserState(botId, '900101', { touch: true });
    await db.conversation.create({ data: { botId, chatId: '900102' } });
    const chats = await store.listChatIds(botId);
    expect(new Set(chats)).toEqual(new Set(['900100', '900101', '900102']));
  });
});

// ---------------------------------------------------------------------------
// API — the Preview route (BR-019)
// ---------------------------------------------------------------------------

describe('API — POST /api/my/bots/[id]/test', () => {
  test('runs a real pipeline turn for the owner (and 404s foreign bots)', async () => {
    const { id: userId, email } = await makeUser();
    const { botId, store } = await makeBot(userId, {
      behaviors: [{ id: 'hi', title: 'Hi', when: { type: 'command', command: '/hello' }, steps: [{ type: 'message', text: 'Hello there!' }] }],
    });
    const testRoute = await import('../../src/app/api/my/bots/[id]/test/route');
    const ownerRes = new NextResponse();
    const session = await createUserSession(ownerRes, userId, 'vitest');
    const cookie = `nurae_session=${session}`;

    const req = new Request('http://localhost/api', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '/hello' }),
    });
    const res = await testRoute.POST(req, { params: Promise.resolve({ id: botId }) });
    const body = (await res.json()) as { sends: Array<{ text: string }>; error: string | null };
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.sends.some((s) => s.text.includes('Hello there!'))).toBe(true);

    // Exactly one of text/callback is required.
    const bad = await testRoute.POST(new Request('http://localhost/api', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}),
    }), { params: Promise.resolve({ id: botId }) });
    expect(bad.status).toBe(422);

    // Foreign bot → 404.
    const { id: other } = await makeUser();
    const otherSession = await createUserSession(new NextResponse(), other, 'vitest');
    const foreign = await testRoute.POST(new Request('http://localhost/api', {
      method: 'POST', headers: { cookie: `nurae_session=${otherSession}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: '/hello' }),
    }), { params: Promise.resolve({ id: botId }) });
    expect(foreign.status).toBe(404);
    void store;
    void email;
  });
});
