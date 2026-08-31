/**
 * NURAE — Telegram webhook receiver tests (Steps 5, 12, 13).
 *
 * Covers: secret verification (missing/wrong/valid), the full message flow
 * (webhook → pipeline → memory → AI → Telegram send), command routing,
 * duplicate update suppression, malformed payloads, and non-text updates.
 */

import { describe, expect, test, afterAll } from 'bun:test';
import { installTelegramStub, STUB_TELEGRAM_TOKEN, telegramState } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

installTelegramStub();

const { db } = await import('../../src/lib/db');
const projectsRoute = await import('../../src/app/api/projects/route');
const projectBotsRoute = await import('../../src/app/api/projects/[id]/bots/route');
const botStartRoute = await import('../../src/app/api/bots/[id]/start/route');
const webhookRoute = await import('../../src/app/api/telegram/webhook/[id]/route');

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

function webhookReq(botId: string, body: unknown, secret?: string): Request {
  return new Request(`http://localhost:3000/api/telegram/webhook/${botId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret !== undefined ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function update(id: number, text: string, chatId = 555): Record<string, unknown> {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 7, is_bot: false, first_name: 'Alice' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

let botId = '';
let webhookSecret = '';

afterAll(async () => {
  await db.$disconnect();
});

describe('Telegram webhook receiver', () => {
  test('setup: create + start a bot via the API (registers webhook secret)', async () => {
    const pRes = await projectsRoute.POST(
      new Request('http://localhost:3000/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Webhook project' }),
      }),
    );
    const pid = ((await pRes.json()) as { project: { id: string } }).project.id;

    const bRes = await projectBotsRoute.POST(
      new Request(`http://localhost:3000/api/projects/${pid}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Hooked',
          telegramToken: STUB_TELEGRAM_TOKEN,
          provider: 'openai',
          model: 'gpt-4o-mini',
          apiKey: 'sk-webhook-test-key-1234567890',
          memorySize: 5,
        }),
      }),
      ctx(pid),
    );
    botId = ((await bRes.json()) as { bot: { id: string } }).bot.id;

    const start = await botStartRoute.POST(
      new Request(`http://localhost:3000/api/bots/${botId}/start`, { method: 'POST' }),
      ctx(botId),
    );
    expect(start.status).toBe(200);

    const wh = telegramState.registry.get(STUB_TELEGRAM_TOKEN);
    expect(wh?.url).toBe(`http://localhost:3000/api/telegram/webhook/${botId}`);
    webhookSecret = wh!.secret;
    expect(webhookSecret.length).toBeGreaterThanOrEqual(32);
  });

  test('missing secret header → 401', async () => {
    const res = await webhookRoute.POST(webhookReq(botId, update(9001, 'hi')), ctx(botId));
    expect(res.status).toBe(401);
  });

  test('wrong secret → 401', async () => {
    const res = await webhookRoute.POST(webhookReq(botId, update(9002, 'hi'), 'wrong-secret-value'), ctx(botId));
    expect(res.status).toBe(401);
  });

  test('unknown bot → 401 (secret check fails first, no existence oracle)', async () => {
    const res = await webhookRoute.POST(webhookReq('bot-does-not-exist', update(9003, 'hi'), 'anything'), ctx('bot-does-not-exist'));
    expect(res.status).toBe(401);
  });

  test('malformed payload → 400', async () => {
    const res = await webhookRoute.POST(webhookReq(botId, { nope: true }, webhookSecret), ctx(botId));
    expect(res.status).toBe(400);
    const req = new Request(`http://localhost:3000/api/telegram/webhook/${botId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret },
      body: '{invalid',
    });
    const res2 = await webhookRoute.POST(req, ctx(botId));
    expect(res2.status).toBe(400);
  });

  test('/start command → welcome message sent to Telegram', async () => {
    const before = telegramState.sends.length;
    const res = await webhookRoute.POST(webhookReq(botId, update(9100, '/start'), webhookSecret), ctx(botId));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const sends = telegramState.sends.slice(before);
    expect(sends.some((s) => s.text.includes('Hooked is online'))).toBe(true);
  });

  test('normal text → AI reply delivered via Telegram (full pipeline)', async () => {
    const before = telegramState.sends.length;
    const res = await webhookRoute.POST(webhookReq(botId, update(9101, 'What is NURAE?'), webhookSecret), ctx(botId));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const sends = telegramState.sends.slice(before);
    expect(sends.some((s) => s.text === 'stubbed AI reply')).toBe(true);

    // Conversation memory: user + assistant turns persisted.
    const conversation = await db.conversation.findUnique({
      where: { botId_chatId: { botId, chatId: '555' } },
    });
    expect(conversation).not.toBeNull();
    const messages = await db.message.findMany({
      where: { conversationId: conversation!.id },
      orderBy: { timestamp: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('stubbed AI reply');
  });

  test('duplicate update_id is suppressed (Telegram retry safety)', async () => {
    const before = telegramState.sends.length;
    const res1 = await webhookRoute.POST(webhookReq(botId, update(9102, 'once'), webhookSecret), ctx(botId));
    expect(res1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const afterFirst = telegramState.sends.length;

    const res2 = await webhookRoute.POST(webhookReq(botId, update(9102, 'once'), webhookSecret), ctx(botId));
    expect(res2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(telegramState.sends.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(before);
  });

  test('non-text updates are acknowledged but ignored', async () => {
    const before = telegramState.sends.length;
    const body = {
      update_id: 9103,
      message: {
        message_id: 9103,
        from: { id: 7, is_bot: false, first_name: 'Alice' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
      }, // no text (e.g. photo)
    };
    const res = await webhookRoute.POST(webhookReq(botId, body, webhookSecret), ctx(botId));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(telegramState.sends.length).toBe(before);
  });

  test('webhook POST bodies never expose the secret in error paths', async () => {
    const res = await webhookRoute.POST(webhookReq(botId, update(9104, 'x'), 'bad'), ctx(botId));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(webhookSecret);
    expect(text).not.toContain(STUB_TELEGRAM_TOKEN);
  });
});
