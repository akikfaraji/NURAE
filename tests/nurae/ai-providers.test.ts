import { describe, expect, test } from 'bun:test';
import { AIError, classifyProviderError } from '../../src/lib/nurae/ai/types';
import { OpenAICompatibleProvider } from '../../src/lib/nurae/ai/providers/openai-compatible';
import { PROVIDER_CATALOG, getProviderInfo, providerNeedsKey, selectProvider } from '../../src/lib/nurae/ai/registry';
import { ZaiProvider } from '../../src/lib/nurae/ai/providers/zai';

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
    fetchImpl: async () => {
      throw new Error('fetch not mocked');
    },
    ...overrides,
  });
}

describe('provider registry & selector', () => {
  test('catalog covers the required provider families', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    for (const id of ['zai', 'openai', 'openrouter', 'deepseek', 'glm', 'local', 'custom']) {
      expect(ids).toContain(id);
    }
    expect(getProviderInfo('zai')?.requiresKey).toBe(false);
    expect(getProviderInfo('openai')?.requiresKey).toBe(true);
    expect(getProviderInfo('openai')?.defaultBaseUrl).toBe('https://api.openai.com/v1');
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
    expect(providerNeedsKey('zai')).toBe(false);
    expect(providerNeedsKey('openai')).toBe(true);
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

  test('validateCredentials: 401 on /models → invalid', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ error: {} }, 401) });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(false);
  });

  test('validateCredentials: ok on /models → valid', async () => {
    const p = makeProvider({ fetchImpl: async () => jsonRes({ data: [] }) });
    const res = await p.validateCredentials(CONFIG);
    expect(res.valid).toBe(true);
  });
});

describe('built-in zai provider', () => {
  test('generate via mocked SDK client', async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async (args: Record<string, unknown>) => {
            expect(Array.isArray(args.messages)).toBe(true);
            return { choices: [{ message: { content: 'GLM says hi' } }] };
          },
        },
      },
    };
    const p = new ZaiProvider({ factory: async () => fakeClient });
    const out = await p.generate(MESSAGES, { model: 'glm-4.5-flash', temperature: 0.7, maxTokens: 256 });
    expect(out).toBe('GLM says hi');
  });

  test('empty SDK response → invalid_response', async () => {
    const fakeClient = {
      chat: { completions: { create: async () => ({ choices: [] }) } },
    };
    const p = new ZaiProvider({ factory: async () => fakeClient });
    try {
      await p.generate(MESSAGES, { model: 'glm-4.5-flash', temperature: 0.7, maxTokens: 8 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AIError).code).toBe('invalid_response');
    }
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
