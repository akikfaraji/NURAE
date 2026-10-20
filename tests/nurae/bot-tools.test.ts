/**
 * Bot-scoped AI tools — unit tests.
 * Pipeline wiring is exercised in the telegram/ecosystem suites; here we pin
 * the registry contract, the security guards (reserved keys, size caps,
 * structural scope) and the generateWithTools loop.
 */
import { describe, expect, test } from 'vitest';
import {
  botToolDefs,
  executeBotTool,
  runWithBotTools,
  type BotToolContext,
} from '../../src/lib/nurae/runtime/bot-tools';
import type { ChatMessage } from '../../src/lib/nurae/ai/types';

/** Minimal fake store — only the state/log surface the tools touch. */
function makeStore() {
  const attrs: Record<string, Record<string, string>> = {};
  const logs: Array<{ event?: string; message: string }> = [];
  return {
    logs,
    async getUserState(botId: string, chatId: string) {
      return { botId, chatId, attributes: { ...(attrs[chatId] ?? {}) }, awaiting: null, resumeRuleId: null, resumeStep: null, startPayload: null };
    },
    async updateUserState(_botId: string, chatId: string, patch: { attributes?: Record<string, string | null> }) {
      const cur = (attrs[chatId] ??= {});
      for (const [k, v] of Object.entries(patch.attributes ?? {})) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
    },
    async createLog(_botId: unknown, _level: unknown, message: string, event?: string) {
      logs.push({ message, event });
    },
  };
}

/** Record stub carrying only the fields the tools read (no secret-shaped keys). */
function makeBot(overrides: Record<string, unknown> = {}): BotToolContext['bot'] {
  return {
    id: 'bot-1',
    name: 'Zathaix',
    ownerChatId: 'owner-chat',
    capabilities: {
      commands: [{ command: '/menu', description: 'Show menu', kind: 'static' as const, response: '' }],
      replies: [{ id: 'r1', name: 'Welcome', trigger: { type: 'start' as const, value: '' }, messages: [] }],
    },
    ...overrides,
  } as unknown as BotToolContext['bot'];
}

function ctx(overrides: Record<string, unknown> = {}): BotToolContext {
  return { bot: makeBot(), chatId: 'chat-1', store: makeStore() as never, ...overrides };
}

describe('bot tool registry', () => {
  test('exposes the four bot-scoped tools with JSON-schema parameters', () => {
    const defs = botToolDefs();
    expect(defs.map((d) => d.name).sort()).toEqual(
      ['list_bot_commands', 'notify_owner', 'recall_user_info', 'remember_user_fact'].sort(),
    );
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('remember_user_fact / recall_user_info', () => {
  test('stores an attribute the flows/placeholders can see', async () => {
    const c = ctx();
    const out = await executeBotTool(c, 'remember_user_fact', { key: 'Favorite Color', value: 'blue' });
    expect(out.ok).toBe(true);
    expect(out.label).toContain('favorite_color');
    const back = await executeBotTool(c, 'recall_user_info', {});
    expect(back.ok).toBe(true);
    expect(back.data).toEqual({ favorite_color: 'blue' });
  });

  test('accepts string-encoded JSON arguments (native tool_calls shape)', async () => {
    const c = ctx();
    const out = await executeBotTool(c, 'remember_user_fact', '{"key":"city","value":"Tehran"}');
    expect(out.ok).toBe(true);
    const back = await executeBotTool(c, 'recall_user_info', '');
    expect(back.data).toEqual({ city: 'Tehran' });
  });

  test('reserved attribute prefixes are unwritable', async () => {
    const c = ctx();
    for (const key of ['_awaiting', 'paid_access']) {
      const out = await executeBotTool(c, 'remember_user_fact', { key, value: 'x' });
      expect(out.ok).toBe(true);
      expect(out.label).toContain('reserved');
    }
    const back = await executeBotTool(c, 'recall_user_info', {});
    expect(back.data).toEqual({});
  });

  test('long keys/values are capped to the store limits', async () => {
    const c = ctx();
    const out = await executeBotTool(c, 'remember_user_fact', { key: 'k'.repeat(500), value: 'v'.repeat(9000) });
    expect(out.ok).toBe(true);
    const back = (await executeBotTool(c, 'recall_user_info', {})) as { data: Record<string, string> };
    const [key, value] = Object.entries(back.data)[0];
    expect(key.length).toBeLessThanOrEqual(64);
    expect(value.length).toBeLessThanOrEqual(2000);
  });
});

describe('list_bot_commands / notify_owner', () => {
  test('lists commands and flows from the loaded capabilities', async () => {
    const out = await executeBotTool(ctx(), 'list_bot_commands', {});
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({
      commands: [{ command: '/menu', description: 'Show menu' }],
      flows: [{ name: 'Welcome', trigger: 'start' }],
    });
  });

  test('notify_owner reports an unlinked owner instead of throwing', async () => {
    const out = await executeBotTool(ctx({ bot: makeBot({ ownerChatId: null }) }), 'notify_owner', { message: 'hi' });
    expect(out.ok).toBe(true);
    expect(out.label).toContain('not reachable');
  });
});

describe('tool hygiene', () => {
  test('unknown tools fail clean, malformed JSON args become {}', async () => {
    const c = ctx();
    expect((await executeBotTool(c, 'nope', {})).ok).toBe(false);
    const out = await executeBotTool(c, 'remember_user_fact', '{broken json');
    expect(out.ok).toBe(true);
    expect(out.label).toContain('needs a key');
  });

  test('tools never touch another bot or chat (structural scope)', async () => {
    const store = makeStore();
    const a = { bot: makeBot(), chatId: 'chat-A', store } as BotToolContext;
    const b = { bot: makeBot({ id: 'bot-2' }), chatId: 'chat-B', store } as BotToolContext;
    await executeBotTool(a, 'remember_user_fact', { key: 'who', value: 'a' });
    const bView = (await executeBotTool(b, 'recall_user_info', {})) as { data: Record<string, string> };
    expect(bView.data).toEqual({});
  });
});

describe('runWithBotTools', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'remember I like blue' }];

  test('no tool calls → returns the first content unchanged', async () => {
    const provider = {
      generateWithTools: async () => ({ content: 'Noted!', toolCalls: [] }),
      generate: async () => 'should not be called',
    };
    const reply = await runWithBotTools(provider as never, messages, { model: 'm', temperature: 0, maxTokens: 8 }, ctx());
    expect(reply).toBe('Noted!');
  });

  test('tool call → executes, feeds results back, returns the final generate', async () => {
    const c = ctx();
    let sawResults = false;
    const provider = {
      generateWithTools: async () => ({
        content: '',
        toolCalls: [{ name: 'remember_user_fact', arguments: '{"key":"color","value":"blue"}' }],
      }),
      generate: async (_msgs: ChatMessage[], _cfg: unknown) => {
        throw new Error('final round must use generateWithTools result path via generate');
      },
    } as never as { generateWithTools: never; generate: never };
    // The final round goes through provider.generate — assert it saw TOOL RESULTS.
    const withGenerate = {
      generateWithTools: (provider as { generateWithTools: unknown }).generateWithTools,
      generate: async (msgs: ChatMessage[]) => {
        sawResults = msgs.some((m) => m.content.includes('TOOL RESULTS') && m.content.includes('remember_user_fact'));
        return 'Done — blue it is.';
      },
    };
    const reply = await runWithBotTools(withGenerate as never, messages, { model: 'm', temperature: 0, maxTokens: 8 }, c);
    expect(reply).toBe('Done — blue it is.');
    expect(sawResults).toBe(true);
    const back = (await executeBotTool(c, 'recall_user_info', {})) as { data: Record<string, string> };
    expect(back.data).toEqual({ color: 'blue' });
  });
});
