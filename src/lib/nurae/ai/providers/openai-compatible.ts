/**
 * NURAE — generic OpenAI-compatible provider.
 *
 * One implementation covers every OpenAI-shaped API (OpenAI, OpenRouter,
 * DeepSeek, GLM open platform, Ollama/vLLM locally, custom endpoints).
 * Provider presets differ only in default base URL and credential env var.
 *
 * Reliability: bounded timeout (AbortController), classification of HTTP
 * status codes, and bounded retry with exponential backoff for transient
 * failures (network, 5xx, 429 with Retry-After).
 */

import {
  AIError,
  AIProvider,
  AIRequestConfig,
  AIToolCall,
  ChatMessage,
  CredentialCheckResult,
} from '../types';
import { assertSafeAiUrl } from '../url-guard';

export interface OpenAICompatibleOptions {
  id: string;
  defaultBaseUrl: string;
  /** Env var checked when the bot has no stored key. */
  apiKeyEnvVar?: string;
  /** Request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Max attempts for retryable failures (default 3 = 1 try + 2 retries). */
  maxAttempts?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable SSRF guard for tests (default: the real assertSafeAiUrl).
   * Tests that mock HTTP with fake hostnames pass a pass-through; production
   * always uses the real guard, which fails closed on unverifiable hosts.
   */
  guardImpl?: typeof assertSafeAiUrl;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; type?: string };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly defaultBaseUrl: string;
  private readonly apiKeyEnvVar?: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly guardImpl: typeof assertSafeAiUrl;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.defaultBaseUrl = opts.defaultBaseUrl;
    this.apiKeyEnvVar = opts.apiKeyEnvVar;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.guardImpl = opts.guardImpl ?? assertSafeAiUrl;
  }

  private endpoint(baseUrl: string | null | undefined, path: string): string {
    const base = (baseUrl || this.defaultBaseUrl || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private headers(config: AIRequestConfig): Record<string, string> {
    const key = config.apiKey || this.envKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  }

  envKey(): string | null {
    if (!this.apiKeyEnvVar) return null;
    return process.env[this.apiKeyEnvVar] || null;
  }

  private async requestOnce(
    url: string,
    body: unknown,
    config: AIRequestConfig,
    method = 'POST',
  ): Promise<{ ok: boolean; status: number; json: ChatCompletionResponse | null; retryAfterMs?: number }> {
    // SSRF guard: baseUrl may be user-supplied (bot config). Block non-http(s)
    // schemes and private/reserved targets BEFORE any socket is opened. This
    // is the single fetch chokepoint for generate/stream/validate.
    let currentUrl = await this.guardImpl(url);

    // Redirects are followed MANUALLY so every hop passes the SSRF guard
    // again. Native fetch follows 3xx transparently — a user-supplied
    // baseUrl pointing at a public server that 302-redirects to
    // http://169.254.169.254/… would otherwise bypass the guard entirely
    // (the guard only ever saw the first URL).
    const MAX_HOPS = 3;
    let currentMethod = method;
    // Set once a redirect crosses origins — every later hop goes out without
    // credentials (browser behavior). Cannot be expressed via config.apiKey
    // alone: headers() would fall back to the provider's env key.
    let stripAuth = false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    config.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const headers = this.headers(config);
        if (stripAuth) delete headers.Authorization;
        const res = await this.fetchImpl(currentUrl, {
          method: currentMethod,
          headers,
          body: currentMethod === 'POST' ? JSON.stringify(body) : undefined,
          redirect: 'manual',
          signal: controller.signal,
        });

        if (REDIRECT_STATUS.has(res.status)) {
          const location = res.headers.get('location');
          // Drain the body so the socket can be reused / released.
          try {
            await res.arrayBuffer();
          } catch {
            /* body already consumed or unreadable — irrelevant for redirects */
          }
          if (!location || hop === MAX_HOPS) {
            // No (or too many) redirects: surface the 3xx itself and let the
            // caller classify it — never invent a synthetic failure here.
            return { ok: false, status: res.status, json: null };
          }
          const nextUrl = new URL(location, currentUrl).toString();
          const safeNext = await this.guardImpl(nextUrl); // throws policy_blocked → never retried
          // Browser redirect semantics: 303 always becomes GET; 301/302
          // downgrade POST to GET; 307/308 keep the method (and body).
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
          }
          // Never leak credentials across origins (mirrors browser behavior).
          if (new URL(safeNext).origin !== new URL(currentUrl).origin) {
            stripAuth = true;
          }
          currentUrl = safeNext;
          continue;
        }

        const retryAfterMs = res.headers.get('retry-after')
          ? Number(res.headers.get('retry-after')) * 1000
          : undefined;
        let json: ChatCompletionResponse | null = null;
        try {
          json = (await res.json()) as ChatCompletionResponse;
        } catch {
          json = null;
        }
        return { ok: res.ok, status: res.status, json, retryAfterMs };
      }
      /* istanbul ignore next — the loop always returns or throws */
      throw new AIError('api_error', 'AI request failed (unreachable redirect loop)');
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(1000 * 2 ** (attempt - 1), 8000);
  }

  async generate(messages: ChatMessage[], config: AIRequestConfig): Promise<string> {
    const url = this.endpoint(config.baseUrl, '/chat/completions');
    const body = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    };

    let lastError: AIError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let result: Awaited<ReturnType<typeof this.requestOnce>>;
      try {
        result = await this.requestOnce(url, body, config);
      } catch (err) {
        // Policy rejections (SSRF guard) are decisions, not failures — never
        // retried, never re-classified as network noise.
        if (err instanceof AIError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = /abort/i.test(message);
        lastError = isTimeout
          ? new AIError('timeout', 'AI request timed out', { retryable: true })
          : new AIError('network_error', `Network error contacting AI provider: ${message}`, {
              retryable: true,
            });
        if (lastError.retryable && attempt < this.maxAttempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw lastError;
      }

      // Fresh attempt: discard any stale error from a previous iteration.
      lastError = null;
      const { ok, status, json, retryAfterMs } = result!;

      if (ok) {
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          throw new AIError('invalid_response', 'AI provider returned an empty or malformed response');
        }
        return content;
      }

      switch (status) {
        case 401:
        case 403:
          throw new AIError('invalid_credentials', 'AI provider rejected the credentials (HTTP 401/403)', {
            status,
          });
        case 429:
          lastError = new AIError('rate_limited', 'AI provider rate limit hit (HTTP 429)', {
            retryable: true,
            status,
            retryAfterMs,
          });
          break;
        default:
          if (status >= 500) {
            lastError = new AIError('api_error', `AI provider server error (HTTP ${status})`, {
              retryable: true,
              status,
            });
          } else {
            const detail = json?.error?.message || `AI provider request failed (HTTP ${status})`;
            throw new AIError('api_error', detail, { status });
          }
      }

      if (lastError && lastError.retryable && attempt < this.maxAttempts) {
        await sleep(lastError.retryAfterMs ?? this.backoff(attempt));
        continue;
      }
      if (lastError) throw lastError;
    }

    throw new AIError('api_error', 'AI request failed after retries');
  }

  async *stream(messages: ChatMessage[], config: AIRequestConfig): AsyncIterable<string> {
    // MVP: stream is derived from generate() to keep the interface future-proof
    // without implementing SSE per provider in this release.
    yield await this.generate(messages, config);
  }

  /**
   * Native OpenAI-style function-calling round. `config.tools` (when present)
   * is sent as OpenAI function definitions; the response's tool_calls come
   * back next to the text instead of being discarded. Retries/timeouts share
   * the generate() machinery by delegating to requestOnce directly.
   */
  async generateWithTools(
    messages: ChatMessage[],
    config: AIRequestConfig,
  ): Promise<{ content: string; toolCalls: AIToolCall[] }> {
    const url = this.endpoint(config.baseUrl, '/chat/completions');
    const tools = config.tools?.length
      ? config.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;
    const body = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
      ...(tools ? { tools, tool_choice: 'auto' as const } : {}),
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let result: Awaited<ReturnType<typeof this.requestOnce>>;
      try {
        result = await this.requestOnce(url, body, config);
      } catch (err) {
        if (err instanceof AIError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = /abort/i.test(message);
        const classified = isTimeout
          ? new AIError('timeout', 'AI request timed out', { retryable: true })
          : new AIError('network_error', `Network error contacting AI provider: ${message}`, { retryable: true });
        if (classified.retryable && attempt < this.maxAttempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw classified;
      }

      const { ok, status, json } = result;
      if (!ok) {
        if (status === 401 || status === 403) {
          throw new AIError('invalid_credentials', 'AI provider rejected the credentials (HTTP 401/403)', { status });
        }
        if (status === 429 && attempt < this.maxAttempts) {
          await sleep(result.retryAfterMs ?? this.backoff(attempt));
          continue;
        }
        if (status >= 500 && attempt < this.maxAttempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
        const detail = json?.error?.message || `AI provider request failed (HTTP ${status})`;
        throw new AIError('api_error', detail, { status });
      }

      const choice = json?.choices?.[0]?.message;
      const content = typeof choice?.content === 'string' ? choice.content : '';
      const rawCalls = Array.isArray(choice?.tool_calls) ? choice!.tool_calls : [];
      const toolCalls: AIToolCall[] = [];
      for (const c of rawCalls) {
        const fn = (c as { function?: { name?: unknown; arguments?: unknown } }).function;
        const name = typeof fn?.name === 'string' ? fn.name : '';
        if (!name) continue;
        const args = fn?.arguments;
        toolCalls.push({
          name,
          arguments: typeof args === 'string' || (args !== null && typeof args === 'object') ? args : {},
        });
      }
      return { content, toolCalls };
    }
    throw new AIError('api_error', 'AI request failed after retries');
  }

  async validateCredentials(config: Partial<AIRequestConfig>): Promise<CredentialCheckResult> {
    const key = config.apiKey || this.envKey();
    if (!key && this.apiKeyEnvVar) {
      // Providers like `local` do not need keys; only flag when the preset expects one.
      if (this.requiresKeyByDefault()) {
        return { valid: false, detail: 'No API key configured for this provider.' };
      }
    }
    const probeConfig: AIRequestConfig = {
      model: config.model || 'default',
      temperature: 0,
      maxTokens: 8,
      apiKey: key,
      baseUrl: config.baseUrl || null,
    };
    try {
      // A tiny REAL chat call is the ONLY trustworthy probe. Several gateways
      // (OpenRouter among them) serve GET /models 200 even for keys that
      // cannot generate at all (e.g. deleted account → 401 "User not found"
      // on chat), so probing /models first reported dead keys as healthy and
      // every real turn then failed with "the AI layer rejected its
      // credentials". Chat-first also validates the configured MODEL, which
      // /models never could. Cost: one 8-token request per check (cached 60s
      // by callers). /models stays only as a fallback for gateways that do
      // not implement /chat/completions at all.
      const chat = await this.requestOnce(
        this.endpoint(probeConfig.baseUrl, '/chat/completions'),
        { model: probeConfig.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
        probeConfig,
      );
      if (chat.ok) return { valid: true, detail: 'Credentials accepted.' };
      if (chat.status === 401 || chat.status === 403) {
        return { valid: false, detail: `Credentials rejected by provider (HTTP ${chat.status}).` };
      }
      // Gateway may not implement /chat/completions — only NOW is /models
      // evidence worth anything. Note this can still miss a key that is
      // valid for listing but not for generation on such gateways; every
      // mainstream provider exposes chat, so chat-first is the default truth.
      if (chat.status === 404) {
        const res = await this.requestOnce(this.endpoint(probeConfig.baseUrl, '/models'), undefined, probeConfig, 'GET');
        if (res.ok) return { valid: true, detail: 'Credentials accepted at /models (chat endpoint unavailable).' };
        if (res.status === 401 || res.status === 403) {
          return { valid: false, detail: `Credentials rejected by provider (HTTP ${res.status}).` };
        }
      }
      return { valid: false, detail: `Provider responded with HTTP ${chat.status}.` };
    } catch (err) {
      const aiErr = err instanceof AIError ? err : null;
      return { valid: false, detail: aiErr ? aiErr.message : `Validation request failed: ${String(err)}` };
    }
  }

  private requiresKeyByDefault(): boolean {
    // `local` presets usually need no key.
    return this.id !== 'local';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
