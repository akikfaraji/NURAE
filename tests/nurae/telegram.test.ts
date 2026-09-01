import { describe, expect, test } from 'vitest';
import { TelegramAdapter, TelegramApiError } from '../../src/lib/nurae/telegram/adapter';
import { BotRuntime } from '../../src/lib/nurae/runtime/bot-runtime';
import { AIError } from '../../src/lib/nurae/ai/types';
import type { RuntimeBotRecord, RuntimeStore } from '../../src/lib/nurae/runtime/store';
import type { ChatMessage } from '../../src/lib/nurae/ai/types';
import type { TelegramUpdate } from '../../src/lib/nurae/telegram/adapter';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TelegramAdapter (mocked HTTP)', () => {
  test('getMe returns bot profile', async () => {
    const adapter = new TelegramAdapter({
      token: '1234567890:TestTokenNotRealButWellFormedAAAAAA',
      fetchImpl: async () => jsonRes({ ok: true, result: { id: 1, username: 'nurae_bot' } }),
    });
    const me = await adapter.getMe();
    expect(me.username).toBe('nurae_bot');
  });

  test('401 → invalid_token with a clear message', async () => {
    const adapter = new TelegramAdapter({
      token: '1234567890:TestTokenNotRealButWellFormedAAAAAA',
      fetchImpl: async () => jsonRes({ ok: false, error_code: 401, description: 'Unauthorized' }),
    });
    try {
      await adapter.getMe();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as TelegramApiError).code).toBe('invalid_token');
    }
  });

  test('409 → conflict (another webhook/polling session)', async () => {
    const adapter = new TelegramAdapter({
      token: '1234567890:TestTokenNotRealButWellFormedAAAAAA',
      fetchImpl: async () => jsonRes({ ok: false, error_code: 409, description: 'Conflict' }),
    });
    try {
      await adapter.getUpdates(0);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramApiError).code).toBe('conflict');
      expect((err as TelegramApiError).retryable).toBe(false);
    }
  });

  test('429 → rate_limited with retry_after in milliseconds', async () => {
    const adapter = new TelegramAdapter({
      token: '1234567890:TestTokenNotRealButWellFormedAAAAAA',
      fetchImpl: async () =>
        jsonRes({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }),
    });
    try {
      await adapter.getUpdates(0);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramApiError).code).toBe('rate_limited');
      expect((err as TelegramApiError).retryable).toBe(true);
      expect((err as TelegramApiError).retryAfterMs).toBe(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// BotRuntime message handling with a fake Telegram + fake provider
// ---------------------------------------------------------------------------

interface FakeOptions {
  updates: TelegramUpdate[];
  getMeFail?: boolean;
  failSends?: boolean;
}

function makeFakeAdapter(opts: FakeOptions) {
  const sent: Array<{ chatId: number; text: string }> = [];
  let idx = 0;
  const controller = new AbortController();
  const adapter = {
    async getMe() {
      if (opts.getMeFail) {
        throw new TelegramApiError('invalid_token', 'Telegram rejected the bot token (401 Unauthorized). Check the token.');
      }
      return { id: 42, username: 'fake_bot' };
    },
    async deleteWebhook() {},
    async getUpdates(_offset: number, o?: { signal?: AbortSignal }) {
      if (idx < opts.updates.length) {
        return [opts.updates[idx++]];
      }
      // Idle: block until aborted (mimics long polling).
      return new Promise<TelegramUpdate[]>((resolve) => {
        const onAbort = () => resolve([]);
        o?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    async sendMessage(chatId: number | string, text: string) {
      if (opts.failSends) throw new TelegramApiError('api_error', 'send failed', { retryable: true });
      sent.push({ chatId: Number(chatId), text });
    },
    __abort: controller,
  };
  return { adapter, sent };
}

export function makeStore() {
  const bots = new Map<string, RuntimeBotRecord>();
  const conversations = new Map<string, string>(); // `${botId}:${chatId}` -> id
  const messages = new Map<string, ChatMessage[]>();
  const state = new Map<string, { status: string; statusDetail: string | null; username: string | null }>();
  const logs: Array<{ botId: string | null; level: string; message: string }> = [];
  let convSeq = 0;

  const store: RuntimeStore & { logs: typeof logs } = {
    logs,
    async getBot(id) {
      return bots.get(id) ?? null;
    },
    async updateBotRuntimeState(id, patch) {
      const cur = state.get(id) ?? { status: 'stopped', statusDetail: null, username: null };
      state.set(id, {
        status: patch.status ?? cur.status,
        statusDetail: patch.statusDetail !== undefined ? patch.statusDetail : cur.statusDetail,
        username: patch.telegramUsername !== undefined ? patch.telegramUsername : cur.username,
      });
    },
    async getRecentMessages(botId, chatId, limit) {
      const list = messages.get(`${botId}:${chatId}`) ?? [];
      return list.slice(-limit);
    },
    async appendUserMessage(botId, chatId, content) {
      append(`${botId}:${chatId}`, { role: 'user', content });
    },
    async appendAssistantMessage(botId, chatId, content) {
      append(`${botId}:${chatId}`, { role: 'assistant', content });
    },
    async trimConversation(botId, chatId, keep) {
      const list = messages.get(`${botId}:${chatId}`);
      if (list && list.length > keep) messages.set(`${botId}:${chatId}`, list.slice(-keep));
    },
    async createLog(botId, level, message) {
      logs.push({ botId, level, message });
    },
  };

  function append(key: string, msg: ChatMessage) {
    if (!conversations.has(key)) conversations.set(key, `conv-${++convSeq}`);
    const list = messages.get(key) ?? [];
    list.push(msg);
    messages.set(key, list);
  }

  store.logs = logs;
  return { store, bots, state, messages };
}

export function runtimeRecord(overrides?: Partial<RuntimeBotRecord>): RuntimeBotRecord {
  return {
    id: 'bot-1',
    projectId: 'proj-1',
    name: 'TestBot',
    systemPrompt: 'You are helpful.',
    provider: 'zai',
    model: 'glm-4.5-flash',
    temperature: 0.7,
    maxTokens: 256,
    memorySize: 4,
    enabled: true,
    status: 'stopped',
    telegramToken: '1234567890:TestTokenNotRealButWellFormedAAAAAA',
    apiKey: null,
    baseUrl: null,
    ...overrides,
  };
}

const fakeSelector = () => ({
  provider: {
    id: 'fake',
    generate: async (messages: ChatMessage[]) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      return `echo: ${lastUser?.content}`;
    },
    validateCredentials: async () => ({ valid: true }),
  },
  info: { requiresKey: false, id: 'fake', label: 'Fake' },
  apiKey: null,
  baseUrl: null,
});

function update(id: number, text: string, chatId = 777, fromBot = false): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 1, is_bot: fromBot, first_name: 'Tester' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function startWithUpdates(record: RuntimeBotRecord, store: RuntimeStore, updates: TelegramUpdate[], getMeFail = false) {
  const fake = makeFakeAdapter({ updates, getMeFail });
  const runtime = new BotRuntime(record, {
    store,
    adapterFactory: () => fake.adapter as unknown as TelegramAdapter,
    providerSelector: fakeSelector as unknown as typeof import('../../src/lib/nurae/ai/registry').selectProvider,
  });
  await runtime.start();
  return { runtime, sent: fake.sent };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('BotRuntime — command routing & AI pipeline (spec §9, §16)', () => {
  test('/start gets a welcome, /help gets instructions, normal text gets an AI reply', async () => {
    const { store } = makeStore();
    const { runtime, sent } = await startWithUpdates(
      runtimeRecord(),
      store,
      [update(1, '/start'), update(2, '/help'), update(3, 'What is NURAE?')],
    );
    await settle(250);
    await runtime.stop();

    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent[0].text).toContain('TestBot is online');
    expect(sent[1].text).toContain('/help');
    expect(sent.some((s) => s.text.includes('echo: What is NURAE?'))).toBe(true);
  });

  test('unknown commands get a friendly hint', async () => {
    const { store } = makeStore();
    const { runtime, sent } = await startWithUpdates(runtimeRecord(), store, [update(1, '/frobnicate')]);
    await settle(150);
    await runtime.stop();
    expect(sent.some((s) => s.text.includes('Unknown command'))).toBe(true);
  });

  test('messages from other bots are ignored (no loops)', async () => {
    const { store } = makeStore();
    const { runtime, sent } = await startWithUpdates(runtimeRecord(), store, [update(1, 'hi', 1, true)]);
    await settle(120);
    await runtime.stop();
    expect(sent.length).toBe(0);
  });

  test('conversation memory stores user + assistant turns (spec §11)', async () => {
    const ms = makeStore();
    const { runtime } = await startWithUpdates(runtimeRecord(), ms.store, [update(1, 'hello world')]);
    await settle(150);
    await runtime.stop();
    const key = 'bot-1:777';
    const list = ms.messages.get(key)!;
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(list[0].content).toBe('hello world');
    expect(list[1].content).toBe('echo: hello world');
  });

  test('AI failure sends a friendly message and the loop continues (spec §17)', async () => {
    const { store } = makeStore();
    const failingSelector = () => ({
      provider: {
        id: 'fake',
        generate: async () => {
          throw new AIError('rate_limited', 'provider rate limit', { retryable: true });
        },
        validateCredentials: async () => ({ valid: true }),
      },
      info: { requiresKey: false, id: 'fake', label: 'Fake' },
      apiKey: null,
      baseUrl: null,
    });
    const fake = makeFakeAdapter({ updates: [update(1, 'ping'), update(2, '/start')] });
    const runtime = new BotRuntime(runtimeRecord(), {
      store,
      adapterFactory: () => fake.adapter as unknown as TelegramAdapter,
      providerSelector: failingSelector as unknown as typeof import('../../src/lib/nurae/ai/registry').selectProvider,
    });
    await runtime.start();
    await settle(200);
    await runtime.stop();

    expect(fake.sent.some((s) => s.text.startsWith('⚠️') && s.text.includes('rate'))).toBe(true);
    // The bot is still running and answered the later /start.
    expect(fake.sent.some((s) => s.text.includes('is online'))).toBe(true);
  });

  test('invalid Telegram token puts the bot into error state (spec §17)', async () => {
    const ms = makeStore();
    await expect(
      startWithUpdates(runtimeRecord(), ms.store, [], true),
    ).rejects.toThrow(/401/);
    await settle(50);
    expect(ms.state.get('bot-1')?.status).toBe('error');
    expect(ms.state.get('bot-1')?.statusDetail).toContain('401');
  });

  test('disabled bots refuse to start', async () => {
    const { store } = makeStore();
    const fake = makeFakeAdapter({ updates: [] });
    const runtime = new BotRuntime(runtimeRecord({ enabled: false }), {
      store,
      adapterFactory: () => fake.adapter as unknown as TelegramAdapter,
    });
    await expect(runtime.start()).rejects.toThrow(/disabled/);
  });

  test('memory trimming keeps only the newest memorySize messages', async () => {
    const ms = makeStore();
    const record = runtimeRecord({ memorySize: 4 });
    const { runtime } = await startWithUpdates(
      record,
      ms.store,
      [update(1, 'one'), update(2, 'two'), update(3, 'three')],
    );
    await settle(250);
    await runtime.stop();
    const list = ms.messages.get('bot-1:777')!;
    expect(list.length).toBeLessThanOrEqual(4);
    expect(list[list.length - 1].content).toBe('echo: three');
  });
});
