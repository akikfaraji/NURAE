/**
 * NURAE — Behavior layer tests (Task 19): the intent-first compiler, the
 * /start + AI-step pipeline paths, behavior persistence via user-bots, and
 * the bot_set_behaviors tool.
 *
 * The flagship example throughout: "When someone starts the bot, welcome them
 * with buttons for Menu, Order, and Contact."
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE, telegramState } from './telegram-stub';

import { pushTestSchema } from './helpers';
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const { serializeCapabilities, loadCapabilities } = await import('../../src/lib/nurae/bots/capabilities');
const {
  compileBehaviors,
  deriveBehaviors,
  serializeBehaviors,
  loadBehaviors,
  BehaviorCompileError,
} = await import('../../src/lib/nurae/bots/behavior');
const { createUserBot, updateUserBot, getUserBot } = await import('../../src/lib/nurae/bots/user-bots');
const { executeTool } = await import('../../src/lib/nurae/agents/tools');
const { createUserSession } = await import('../../src/lib/nurae/auth/sessions');
const { handleBotMessage, handleBotCallback, capturingSender } = await import('../../src/lib/nurae/runtime/pipeline');
const { createPrismaRuntimeStore } = await import('../../src/lib/nurae/runtime/store');

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let userCounter = 0;

async function makeUser(): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = `t19-${userCounter}-${Date.now()}@example.com`;
  const user = await db.user.create({
    data: { name: `T19 User ${userCounter}`, email, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email };
}

/** The restaurant example, verbatim from the product intent. */
function restaurantBehaviors() {
  return [
    {
      id: 'welcome',
      title: 'Welcome',
      when: { type: 'start' },
      steps: [
        {
          type: 'message',
          text: 'Welcome! What would you like to do?',
          buttons: [
            { label: 'Menu', action: { kind: 'flow', behaviorId: 'menu' } },
            { label: 'Order', action: { kind: 'message', text: 'Tell me your order and we will confirm.' } },
            { label: 'Contact', action: { kind: 'flow', behaviorId: 'contact' } },
          ],
        },
      ],
    },
    { id: 'menu', title: 'Menu', when: { type: 'button' }, steps: [{ type: 'message', text: 'Today: pizza, pasta, salad.' }] },
    { id: 'contact', title: 'Contact', when: { type: 'button' }, steps: [{ type: 'message', text: 'Write to us at hello@example.com.' }] },
    { id: 'prices', title: 'Prices', when: { type: 'command', command: '/prices' }, steps: [{ type: 'ai', instruction: 'Answer with our price list.' }] },
    { id: 'pricing', title: 'Pricing answer', when: { type: 'says', text: 'price' }, steps: [{ type: 'message', text: 'Everything is 5 NURs today.' }] },
    { id: 'other', title: 'Anything else', when: { type: 'anything_else' }, steps: [{ type: 'ai' }] },
  ];
}

async function runtimeRecord(botId: string) {
  const store = createPrismaRuntimeStore(db);
  return store.getBot(botId);
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

describe('behavior compiler', () => {
  test('the flagship example compiles into real commands + replies', () => {
    const caps = compileBehaviors(restaurantBehaviors() as never);
    console.log('CAPS:', JSON.stringify(caps.replies.map((r) => ({ t: r.trigger, n: r.name }))));

    // A reply rule answers /start with three buttons.
    const welcome = caps.replies.find((r) => r.trigger.type === 'command' && r.trigger.value === '/start');
    expect(welcome).toBeTruthy();
    expect(welcome!.messages[0].text).toContain('Welcome!');
    const row = welcome!.messages[0].buttons![0];
    expect(row).toHaveLength(3);
    expect(row[0].callback).toBe('r:b_menu');
    expect(row[1].callback).toBe('r:a_welcome_0_1');
    expect(row[2].callback).toBe('r:b_contact');

    // "Show a message" buttons get a hidden press rule.
    const orderRule = caps.replies.find((r) => r.trigger.value === 'r:a_welcome_0_1');
    expect(orderRule!.messages[0].text).toContain('Tell me your order');

    // Flow targets are button-trigger rules.
    expect(caps.replies.find((r) => r.trigger.value === 'r:b_menu')!.messages[0].text).toContain('pizza');

    // Command behavior → menu entry (AI) AND discoverability entry for message commands.
    const prices = caps.commands.find((c) => c.command === '/prices');
    expect(prices!.kind).toBe('ai');
    expect(prices!.response).toContain('price list');

    // says → keyword rule; anything_else → fallback rule (single ai step → ai-marked message).
    expect(caps.replies.find((r) => r.trigger.type === 'keyword')!.trigger.value).toBe('price');
    const fallback = caps.replies.find((r) => r.trigger.type === 'fallback')!;
    expect(fallback.messages[0].ai).toBe('');

    // The whole compiled artifact re-validates against the pipeline schemas.
    const round = serializeCapabilities(caps);
    expect(loadCapabilities(round)).toEqual(caps);
  });

  test('recompiles keep callbacks deterministic', () => {
    const a = compileBehaviors(restaurantBehaviors() as never);
    const b = compileBehaviors(restaurantBehaviors() as never);
    expect(JSON.stringify(a.replies.map((r) => r.trigger))).toBe(JSON.stringify(b.replies.map((r) => r.trigger)));
  });

  test('broken intents fail with human-readable issues — never a poisoned bot', () => {
    expect(() => compileBehaviors([
      { id: 'x', title: 'A', when: { type: 'start' }, steps: [{ type: 'message', text: 'hi' }] },
      { id: 'x', title: 'B', when: { type: 'says', text: 'hi' }, steps: [{ type: 'message', text: 'hi' }] },
    ] as never)).toThrow(BehaviorCompileError);

    expect(() => compileBehaviors([
      { id: 'w', title: 'W', when: { type: 'start' }, steps: [{ type: 'message', text: 'hi', buttons: [{ label: 'Ghost', action: { kind: 'flow', behaviorId: 'missing' } }] }] },
    ] as never)).toThrow(/does not exist/);

    expect(() => compileBehaviors([
      { id: 'a', title: 'A', when: { type: 'command', command: '/menu' }, steps: [{ type: 'message', text: 'x' }] },
      { id: 'b', title: 'B', when: { type: 'command', command: '/menu' }, steps: [{ type: 'message', text: 'y' }] },
    ] as never)).toThrow(/\/menu/);

    expect(() => compileBehaviors([
      { id: 'a', title: 'A', when: { type: 'start' }, steps: [{ type: 'message', text: 'x' }] },
      { id: 'b', title: 'B', when: { type: 'start' }, steps: [{ type: 'message', text: 'y' }] },
    ] as never)).toThrow(/starts the bot/);

    expect(() => compileBehaviors([
      { id: 'a', title: 'A', when: { type: 'anything_else' }, steps: [{ type: 'message', text: 'x' }] },
      { id: 'b', title: 'B', when: { type: 'anything_else' }, steps: [{ type: 'message', text: 'y' }] },
    ] as never)).toThrow(/anything else/);
  });

  test('derive → compile round-trip preserves runtime behavior', () => {
    const caps = compileBehaviors(restaurantBehaviors() as never);
    const behaviors = deriveBehaviors(caps);
    expect(behaviors.length).toBeGreaterThanOrEqual(5);

    const recompiled = compileBehaviors(behaviors);
    const triggerKey = (r: { trigger: { type: string; value?: string } }) => `${r.trigger.type}:${r.trigger.value ?? ''}`;
    // Non-button triggers survive verbatim.
    for (const key of ['command:/start', 'command:/prices', 'keyword:price', 'fallback:']) {
      expect([...recompiled.replies.map(triggerKey)]).toContain(key);
    }
    // Every button in the whole recompiled artifact has an answering rule.
    const keys = new Set(recompiled.replies.map(triggerKey));
    for (const r of recompiled.replies) {
      for (const m of r.messages) {
        for (const row of m.buttons ?? []) {
          for (const b of row) {
            if (!b.url) expect(keys.has(`button:${b.callback}`)).toBe(true);
          }
        }
      }
    }
    // And the welcome message still carries its three buttons.
    const welcome = recompiled.replies.find((r) => r.trigger.value === '/start')!;
    expect(welcome.messages[0].buttons![0]).toHaveLength(3);
  });

  test('serialize/load degrade corrupt rows to empty', () => {
    expect(serializeBehaviors([])).toBeNull();
    expect(loadBehaviors({ behaviorsJson: null })).toEqual([]);
    expect(loadBehaviors({ behaviorsJson: '{not json' })).toEqual([]);
    const stored = serializeBehaviors(restaurantBehaviors() as never);
    expect(loadBehaviors({ behaviorsJson: stored! })).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Persistence through user-bots
// ---------------------------------------------------------------------------

describe('behavior persistence', () => {
  test('createUserBot with behaviors compiles and stores both layers', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Trattoria', behaviors: restaurantBehaviors() as never });
    expect(created.error).toBeUndefined();
    expect(created.bot!.behaviors).toHaveLength(6);
    expect(created.bot!.replies.some((r) => r.trigger.value === '/start')).toBe(true);
    expect(created.bot!.commands.some((c) => c.command === '/prices' && c.kind === 'ai')).toBe(true);

    const row = await db.bot.findUnique({ where: { id: created.bot!.id } });
    expect(row!.behaviorsJson).toContain('welcome');
    expect(await getUserBot(owner.id, created.bot!.id)).toBeTruthy();
  });

  test('behavior save recompiles; empty list clears; compile errors return honestly', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Edit Bot' });
    const botId = created.bot!.id;

    const good = await updateUserBot(owner.id, botId, { behaviors: restaurantBehaviors() as never });
    expect(good.bot!.replies.length).toBeGreaterThan(4);

    // Advanced manual edits stand until the next behavior save.
    await updateUserBot(owner.id, botId, { commands: [{ command: '/manual', description: 'Manual', kind: 'static', response: 'manual!' }] });
    let dto = (await getUserBot(owner.id, botId))!;
    expect(dto.commands.some((c) => c.command === '/manual')).toBe(true);

    await updateUserBot(owner.id, botId, { behaviors: [{ id: 'welcome', title: 'Welcome', when: { type: 'start' }, steps: [{ type: 'message', text: 'hi' }] }] as never });
    dto = (await getUserBot(owner.id, botId))!;
    expect(dto.commands.some((c) => c.command === '/manual')).toBe(false); // recompiled away
    expect(dto.replies).toHaveLength(1);

    const bad = await updateUserBot(owner.id, botId, {
      behaviors: [{ id: 'w', title: 'W', when: { type: 'start' }, steps: [{ type: 'message', text: 'x', buttons: [{ label: 'G', action: { kind: 'flow', behaviorId: 'nope' } }] }] }] as never,
    });
    expect(bad.error).toMatch(/does not exist/);

    const cleared = await updateUserBot(owner.id, botId, { behaviors: [] });
    expect(cleared.bot!.replies).toHaveLength(0);
    expect(cleared.bot!.behaviors).toHaveLength(0);
  });

  test('bot_set_behaviors tool validates, compiles, and audits — with ownership', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Tool Bot' });
    const botId = created.bot!.id;
    const { ensureAgentSession } = await import('../../src/lib/nurae/agents/bot-builder');
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder', title: 'tool test' });

    const ok = await executeTool(
      { userId: owner.id, sessionId },
      'bot_set_behaviors',
      { botId, behaviors: restaurantBehaviors() },
      1,
    );
    expect(ok.status).toBe('ok');
    expect(ok.label).toMatch(/6 behavior/);

    const dto = (await getUserBot(owner.id, botId))!;
    expect(dto.behaviors).toHaveLength(6);

    const foreign = await executeTool(
      { userId: stranger.id, sessionId },
      'bot_set_behaviors',
      { botId, behaviors: [] },
      2,
    );
    expect(foreign.status).toBe('error');
    expect(foreign.label).toMatch(/not yours/);

    const invalid = await executeTool(
      { userId: owner.id, sessionId },
      'bot_set_behaviors',
      { botId, behaviors: [{ id: 'bad id with spaces', title: 'X', when: { type: 'start' }, steps: [{ type: 'message', text: 'x' }] }] },
      3,
    );
    expect(invalid.status).toBe('error');

    const steps = await db.agentStep.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
    expect(steps.map((s) => s.status)).toEqual(['ok', 'error', 'error']);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: the behaviors actually RUN
// ---------------------------------------------------------------------------

describe('behavior pipeline', () => {
  test('/start runs the welcome behavior instead of the built-in text; buttons answer', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Trattoria Live',
      telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
      behaviors: restaurantBehaviors() as never,
    });
    const botId = created.bot!.id;
    const record = await runtimeRecord(botId);
    expect(record).toBeTruthy();

    const sender = capturingSender();
    await handleBotMessage(record!, sender, { chatId: 't:1', text: '/start', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0].text).toContain('Welcome! What would you like to do?');
    expect(sender.sends[0].buttons?.[0][0].text).toBe('Menu');
    expect(sender.sends[0].buttons?.[0][0].callback).toBe('r:b_menu');

    // Press Menu → the flow behavior answers.
    const press = capturingSender();
    await handleBotCallback(record!, press, { chatId: 't:1', callbackId: 'cb1', data: 'r:b_menu', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(press.sends[0].text).toContain('pizza');

    // Press Order (show-a-message action) → its hidden rule answers.
    const order = capturingSender();
    await handleBotCallback(record!, order, { chatId: 't:1', callbackId: 'cb2', data: 'r:a_welcome_0_1', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(order.sends[0].text).toContain('Tell me your order');

    // Without behaviors, /start still says the classic text.
    const plain = await createUserBot(owner.id, { name: 'Plain', telegramToken: '1234567890:AAValidFormatTokenForTesting1234' });
    const plainRecord = await runtimeRecord(plain.bot!.id);
    const plainSender = capturingSender();
    await handleBotMessage(plainRecord!, plainSender, { chatId: 't:2', text: '/start', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(plainSender.sends[0].text).toContain('is online');
  });

  test('"AI answers" command and "Ask the AI" button steps run the bot provider', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'AI Bot',
      telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
      behaviors: [
        { id: 'support', title: 'Support', when: { type: 'command', command: '/support' }, steps: [{ type: 'ai', instruction: 'Act as support.' }] },
        {
          id: 'welcome',
          title: 'Welcome',
          when: { type: 'start' },
          steps: [{ type: 'message', text: 'Hi!', buttons: [{ label: 'Ask us', action: { kind: 'ai', instruction: 'Answer briefly.' } }] }],
        },
      ] as never,
    });
    const botId = created.bot!.id;
    await db.bot.update({
      where: { id: botId },
      data: { provider: 'custom', baseUrl: `${TELEGRAM_STUB_BASE}/v1`, apiKeyRef: SecretManager.encrypt('stub-key') },
    });
    telegramState.aiResponses.push('support reply');
    const cmd = await import('../../src/lib/nurae/bots/user-bots').then((m) => m.testBotTextTurn(owner.id, botId, '/support'));
    expect(cmd.sends).toHaveLength(1);
    expect(cmd.sends[0].text).toContain('support reply');

    // Memory holds the command invocation.
    const conv = await db.conversation.findFirst({ where: { botId } });
    const userMsgs = await db.message.findMany({ where: { conversationId: conv!.id, role: 'user' } });
    expect(userMsgs.some((m) => m.content.includes('/support'))).toBe(true);

    // Button → AI step.
    telegramState.aiResponses.push('button AI reply');
    const btn = await import('../../src/lib/nurae/bots/user-bots').then((m) => m.testBotButtonTurn(owner.id, botId, 'r:a_welcome_0_0'));
    expect(btn.sends).toHaveLength(1);
    expect(btn.sends[0].text).toContain('button AI reply');
  });

  test('keyword and fallback behaviors fire like their technical counterparts', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Keyword Bot',
      telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
      behaviors: [
        { id: 'pricing', title: 'Pricing', when: { type: 'says', text: 'price' }, steps: [{ type: 'message', text: 'All 5 NURs.' }] },
        { id: 'other', title: 'Else', when: { type: 'anything_else' }, steps: [{ type: 'message', text: 'Try asking about prices.' }] },
      ] as never,
    });
    const record = await runtimeRecord(created.bot!.id);
    const s = capturingSender();
    await handleBotMessage(record!, s, { chatId: 't:1', text: 'what is the PRICE here?', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(s.sends[0].text).toContain('All 5 NURs.');
    const s2 = capturingSender();
    await handleBotMessage(record!, s2, { chatId: 't:1', text: 'hello', fromBot: false }, { store: createPrismaRuntimeStore(db) });
    expect(s2.sends[0].text).toContain('Try asking about prices.');
  });
});
