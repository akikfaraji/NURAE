import './helpers';
import { describe, expect, test } from 'vitest';
import { AIError, classifyProviderError } from '../../src/lib/nurae/ai/types';
import { OpenAICompatibleProvider } from '../../src/lib/nurae/ai/providers/openai-compatible';
import { PROVIDER_CATALOG, getProviderInfo, providerNeedsKey, selectProvider } from '../../src/lib/nurae/ai/registry';

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];
const CONFIG = { model: 'test-model', temperature: 0.5, maxTokens: 64, apiKey: 'test-key' };

function jsonRes(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

function makeProvider(overrides?: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]>) {
  return new OpenAICompatibleProvider({
    id: 'openai',
    defaultBaseUrl: 'https://api.test/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    timeoutMs: 500,
    maxAttempts: 1,
    // HTTP-semantics tests use fake hostnames (api.test) that real DNS cannot
    // resolve; the SSRF guard now fails closed on unverifiable hosts, so stub
    // it out here. The guard itself is exercised (with the REAL guard) in
    // security-hardening.test.ts.
    guardImpl: async (url: string) => url,
    fetchImpl: async () => {
      throw new Error('fetch not mocked');
    },
    ...overrides,
  });
}

describe('provider registry & selector', () => {
  test('catalog covers the required provider families', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    for (const id of ['openai', 'openrouter', 'deepseek', 'orca', 'glm', 'local', 'custom']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('zai'); // built-in GLM removed
    expect(getProviderInfo('openrouter')?.defaultModel).toBe('openrouter/free');
    expect(getProviderInfo('openai')?.requiresKey).toBe(true);
    expect(getProviderInfo('openai')?.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(getProviderInfo('orca')?.defaultBaseUrl).toBe('https://api.orcarouter.ai/v1');
    expect(getProviderInfo('orca')?.apiKeyEnvVar).toBe('ORCA_API_KEY');
    expect(getProviderInfo('local')?.defaultBaseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  test('selectProvider resolves orca to the OpenAI-compatible gateway base URL', () => {
    const sel = selectProvider('orca', { apiKey: 'sk-orca-test' });
    expect(sel.provider.id).toBe('orca');
    expect(sel.baseUrl).toBe('https://api.orcarouter.ai/v1');
    expect(sel.apiKey).toBe('sk-orca-test');
  });

  test('selectProvider returns a working provider instance', () => {
    const sel = selectProvider('openai', { apiKey: 'k', baseUrl: null });
    expect(sel.provider.id).toBe('openai');
    expect(sel.apiKey).toBe('k');
    expect(sel.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('selectProvider rejects invalid providers with AIError', () => {
    try {
      selectProvider('skynet-9000');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).code).toBe('provider_not_found');
    }
  });

  test('providerNeedsKey reflects the catalog', () => {
    expect(providerNeedsKey('openrouter')).toBe(true);
    expect(providerNeedsKey('openai')).toBe(true);
  });

  test('legacy zai provider id maps to openrouter', () => {
    const sel = selectProvider('zai', { apiKey: 'k' });
    expect(sel.provider.id).toBe('openrouter');
    expect(sel.info.id).toBe('openrouter');
  });

  test('env var key fallback works when bot has no stored key', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const sel = selectProvider('openai', { apiKey: null });
    expect(sel.apiKey).toBe('env-key');
    delete process.env.OPENAI_API_KEY;
  });
});

describe('OpenAI-compatible provider (mocked HTTP)', () => {
  test('generate returns assistant content on success', async () => {
    const p = makeProvider({
      fetchImpl: async () => jsonRes({ choices: [{ message: { content: 'Hi there!' } }] }),
    });
    const out = await p.generate(MESSAGES, CONFIG);
    expect(out).toBe('Hi there!');
  });

  test('sends model, messages, temperature and max_tokens in the body', async () => {
    let captured: { url: string; body: Record<string, unknown>; auth: string } | null = null;
    const p = makeProvider({
      fetchImpl: async (url, init) => {
        captured = {
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: String(new Headers(init?.headers).get('Authorization')),
        };
        return jsonRes({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await p.generate(MESSAGES, { ...CONFIG, baseUrl: 'https://custom.example/v1' });
    expect(captured!.url).toBe('https://custom.example/v1/chat/completions');
    expect(captured!.body.model).toBe('test-model');
    expect(captured!.body.temperature).toBe(0.5);
    expect(captured!.body.max_tokens).toBe(64);
    expect(captured!.auth).toBe('Bearer test-key');
  });

  test('401/403 → invalid_credentials (non-retryable)', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ error: { message: 'bad key' } }, 401) });
    try {
      await p.generate(MESSAGES, CONFIG);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).code).toBe('invalid_credentials');
      expect((err as AIError).retryable).toBe(false);
    }
  });

  test('400 → api_error (non-retryable)', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ error: { message: 'bad request' } }, 400) });
    try {
      await p.generate(MESSAGES, CONFIG);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AIError).code).toBe('api_error');
      expect((err as AIError).retryable).toBe(false);
    }
  });

  test('network failure → network_error, classified as retryable', async () => {
    const p = makeProvider({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    try {
      await p.generate(MESSAGES, CONFIG);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AIError).code).toBe('network_error');
      expect((err as AIError).retryable).toBe(true);
    }
  });

  test('timeout produces AIError timeout', async () => {
    const p = makeProvider({
      timeoutMs: 80,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    try {
      await p.generate(MESSAGES, CONFIG);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AIError).code).toBe('timeout');
    }
  });

  test('retries 5xx errors and succeeds within the attempt budget', async () => {
    let calls = 0;
    const p = makeProvider({
      maxAttempts: 3,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return jsonRes({ error: { message: 'overloaded' } }, 503);
        return jsonRes({ choices: [{ message: { content: 'recovered' } }] });
      },
    });
    const out = await p.generate(MESSAGES, CONFIG);
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  test('retries 429 and honors Retry-After when present', async () => {
    let calls = 0;
    const p = makeProvider({
      maxAttempts: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonRes({ error: { message: 'slow down' } }, 429, { 'Retry-After': '1' });
        return jsonRes({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    const out = await p.generate(MESSAGES, { ...CONFIG, maxTokens: 8 });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  test('empty response → invalid_response', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ choices: [{ message: { content: '' } }] }) });
    try {
      await p.generate(MESSAGES, CONFIG);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AIError).code).toBe('invalid_response');
    }
  });

  test('validateCredentials: 401 on chat → invalid', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ error: {} }, 401) });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(false);
  });

  test('validateCredentials: ok on chat → valid', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ choices: [{ message: { content: 'pong' } }] }) });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(true);
  });

  test('validateCredentials: chat 404 + /models ok → valid (gateway without chat)', async () => {
    const p = makeProvider({
      fetchImpl: async (_url, init) =>
        String(init?.method ?? 'POST') === 'GET' ? jsonRes({ data: [] }) : jsonRes({ error: 'no chat here' }, 404),
    });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(true);
  });

  // REGRESSION: OpenRouter serves GET /models 200 even for keys that cannot
  // generate (deleted account → 401 "User not found" on chat). The old
  // models-first probe reported such keys as healthy and every real turn
  // then failed. Chat must be probed FIRST and a chat 401 must be final.
  test('validateCredentials: /models 200 but chat 401 → INVALID (no false OK)', async () => {
    const p = makeProvider({
      fetchImpl: async (_url, init) =>
        String(init?.method ?? 'POST') === 'GET' ? jsonRes({ data: [{ id: 'x' }] }) : jsonRes({ error: { message: 'User not found.', code: 401 } }, 401),
    });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(false);
    expect(res.detail).toMatch(/401/);
  });
});

describe('error classification', () => {
  test('classifyProviderError maps abort/network to retryable codes', () => {
    expect(classifyProviderError(new Error('aborted')).code).toBe('timeout');
    expect(classifyProviderError(new Error('fetch failed ENOTFOUND')).code).toBe('network_error');
    const plain = classifyProviderError(new Error('mystery'));
    expect(plain.code).toBe('api_error');
    expect(plain.retryable).toBe(false);
  });
});

describe('generateWithTools (native function calling)', () => {
  test('sends OpenAI-style tool definitions and returns message.tool_calls next to text', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const provider = makeProvider({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Creating your bot now.',
                  tool_calls: [
                    {
                      type: 'function',
                      function: { name: 'bot_create_draft', arguments: '{"name":"FitBot","system_prompt":"Coach"}' },
                    },
                    { type: 'function', function: { name: 'bots_list', arguments: '{}' } },
                  ],
                },
              },
            ],
          }) as unknown as BodyInit,
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const out = await provider.generateWithTools(
      [{ role: 'user', content: 'build a gym bot' }],
      {
        model: 'openrouter/free',
        temperature: 0.3,
        maxTokens: 512,
        apiKey: 'k',
        tools: [{ name: 'bots_list', description: 'List bots', parameters: { type: 'object', properties: {} } }],
      },
    );

    expect(out.content).toBe('Creating your bot now.');
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0]).toEqual({
      name: 'bot_create_draft',
      arguments: '{"name":"FitBot","system_prompt":"Coach"}',
    });
    expect(out.toolCalls[1].arguments).toEqual('{}'); // raw pass-through; the caller parses

    const body = JSON.parse(String(seen[0].init.body)) as {
      tools: Array<{ type: string; function: { name: string } }>;
      tool_choice: string;
    };
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'bots_list' } });
    expect(body.tool_choice).toBe('auto');
  });

  test('malformed tool_call entries are dropped, not thrown', async () => {
    const provider = makeProvider({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'x', tool_calls: [{ function: {} }, { function: { name: 'ok', arguments: null } }] } }],
          }) as unknown as BodyInit,
          { status: 200 },
        )) as typeof fetch,
    });
    const out = await provider.generateWithTools([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0,
      maxTokens: 10,
      apiKey: 'k',
    });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: 'ok', arguments: {} });
  });

  test('no tools in config → no tools field sent, empty call list returned', async () => {
    let body: Record<string, unknown> = {};
    const provider = makeProvider({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }) as unknown as BodyInit, {
          status: 200,
        });
      }) as typeof fetch,
    });
    const out = await provider.generateWithTools([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0,
      maxTokens: 10,
      apiKey: 'k',
    });
    expect(body.tools).toBeUndefined();
    expect(out).toEqual({ content: 'plain', toolCalls: [] });
  });
});
