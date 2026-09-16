/**
 * NURAE — agent loop continuity (BR-034).
 *
 * The user-visible bug: "the agent says working and then it stops."
 *
 * Root causes proven here:
 *   1. From round 1 on, actions were silently DROPPED when the envelope said
 *      done:true — and done defaults to TRUE when the model omits it. Free
 *      models do both constantly → round 0 narrates "Working on it…", every
 *      later envelope's actions get discarded, the turn ends mid-work.
 *   2. When the round budget ran out, the last tool results were never
 *      reported — the turn ended with the stale round-0 narration.
 *   3. An empty final message produced an empty bubble (silent stop).
 *
 * The contract after the fix:
 *   - Actions are ALWAYS executed, in every round.
 *   - After actions execute, the model ALWAYS sees the results before the
 *     turn ends (one reaction round), budget permitting.
 *   - Budget exhaustion triggers a wrap-up; the user gets an honest report
 *     (and a continue hint) instead of silence.
 *   - A turn never ends with an empty reply when work happened (or at all).
 *   - Agent rounds request a generous maxTokens floor so behavior-JSON
 *     envelopes do not truncate mid-generation.
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE, telegramState } from './telegram-stub';
import { pushTestSchema } from './helpers';

pushTestSchema();
installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { ensureOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const { runBotBuilderTurn, ensureAgentSession } = await import('../../src/lib/nurae/agents/bot-builder');

let userCounter = 0;
async function makeUser(): Promise<{ id: string; email: string; name: string }> {
  userCounter += 1;
  const e = `t34-${userCounter}-${Date.now()}@example.com`;
  const user = await db.user.create({
    data: { name: `T34 User ${userCounter}`, email: e, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email: e, name: user.name };
}

/** Point the official platform bot at the stubbed OpenAI-compatible endpoint. */
async function wirePlatformAI(): Promise<void> {
  const botId = await ensureOfficialBot();
  expect(botId).toBeTruthy();
  await db.bot.update({
    where: { id: botId! },
    data: {
      provider: 'custom',
      baseUrl: `${TELEGRAM_STUB_BASE}/v1`,
      apiKeyRef: SecretManager.encrypt('stub-key'),
    },
  });
}

const envelope = (o: unknown) => JSON.stringify(o);

/** Fresh scripted turn: drain leftovers so tests never see each other's replies. */
function scriptTurn(replies: string[]): void {
  telegramState.aiResponses.length = 0;
  telegramState.aiRequests.length = 0;
  telegramState.aiResponses.push(...replies);
}

describe('BR-034: agent loop continuity (the "says working then stops" bug)', () => {
  test('actions are executed even when a working round says done:true (free-model habit)', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    scriptTurn([
      envelope({
        message: 'Working on it — creating your bot now.',
        actions: [{ tool: 'bot_create_draft', args: { name: 'Continuity Bot', description: 'test' } }],
        done: true, // the habit that used to orphan every later round
      }),
      envelope({
        message: '',
        actions: [{ tool: 'bot_set_profile', args: { botId: 'SELF', description: 'The continuity test bot.' } }],
        done: true,
      }),
      envelope({ message: 'Done — your bot is created and configured.', actions: [], done: true }),
    ]);

    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'build it' });

    // The round-1 action (bot_set_profile) must have RUN, not been dropped.
    expect(result.activity.map((a) => a.tool)).toContain('bot_set_profile');
    // The model reacted to the results — the user gets a real final report.
    expect(result.reply).toContain('Done');
    // A draft bot exists.
    expect(await db.bot.count({ where: { ownerId: owner.id } })).toBe(1);
  });

  test('an envelope that OMITS done is not treated as finished while actions remain', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    scriptTurn([
      envelope({ message: 'Working…', actions: [{ tool: 'bot_create_draft', args: { name: 'Omitted Bot', description: '' } }] }),
      envelope({ message: 'Created your draft bot.', actions: [] }),
    ]);

    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'go' });

    expect(result.reply).toContain('Created your draft bot');
    expect(result.activity.length).toBe(1);
    expect(await db.bot.count({ where: { ownerId: owner.id } })).toBe(1);
  });

  test('budget exhaustion ends with a real report — never the stale "Working on it…"', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    // A model that always wants another round and never finishes on its own;
    // the last scripted reply is the wrap-up round the runtime forces.
    scriptTurn([
      envelope({ message: 'Working on it…', actions: [{ tool: 'bot_create_draft', args: { name: 'Endless Bot', description: '' } }], done: false }),
      envelope({ message: '', actions: [{ tool: 'bot_set_profile', args: { botId: 'SELF', description: 'x' } }], done: false }),
      envelope({ message: '', actions: [{ tool: 'bots_list', args: {} }], done: false }),
      envelope({ message: '', actions: [{ tool: 'bots_list', args: {} }], done: false }),
      envelope({ message: '', actions: [{ tool: 'bots_list', args: {} }], done: false }),
      envelope({ message: '', actions: [{ tool: 'bots_list', args: {} }], done: false }),
      envelope({ message: 'Wrap-up: draft created and configured; the rest needs another go.', actions: [], done: true }),
    ]);

    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'keep going' });

    // The turn did NOT end on the stale round-0 narration.
    expect(result.reply).not.toBe('Working on it…');
    expect(result.reply).toContain('Wrap-up');
    // The work actually done is visible in the activity feed.
    expect(result.activity.map((a) => a.tool)).toContain('bot_create_draft');
  });

  test('a turn never ends with an empty reply when tools ran', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    scriptTurn([
      envelope({ message: '', actions: [{ tool: 'bot_create_draft', args: { name: 'Silent Bot', description: '' } }], done: false }),
      envelope({ message: '', actions: [], done: true }),
    ]);

    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'do it' });

    expect(result.reply.trim().length).toBeGreaterThan(0);
  });

  test('agent rounds request a generous maxTokens floor (behavior-JSON envelopes must not truncate)', async () => {
    await wirePlatformAI();
    scriptTurn([envelope({ message: 'Ok.', actions: [], done: true })]);
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });

    await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'hi' });

    expect(telegramState.aiRequests.length).toBeGreaterThan(0);
    for (const body of telegramState.aiRequests) {
      expect(body.max_tokens).toBeGreaterThanOrEqual(3000);
    }
  });
});
