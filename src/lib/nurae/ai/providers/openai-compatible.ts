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
  ChatMessage,
  CredentialCheckResult,
} from '../types';

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
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

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

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.defaultBaseUrl = opts.defaultBaseUrl;
    this.apiKeyEnvVar = opts.apiKeyEnvVar;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    config.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(config),
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
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
      // Cheap probe first: GET /models (no tokens consumed on most providers).
      const res = await this.requestOnce(this.endpoint(probeConfig.baseUrl, '/models'), undefined, probeConfig, 'GET');
      if (res.ok) return { valid: true, detail: 'Credentials accepted.' };
      if (res.status === 401 || res.status === 403) {
        return { valid: false, detail: 'Credentials rejected by provider (HTTP 401/403).' };
      }
      // /models may not exist on some gateways — fall back to a tiny chat call.
      const chat = await this.requestOnce(
        this.endpoint(probeConfig.baseUrl, '/chat/completions'),
        { model: probeConfig.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
        probeConfig,
      );
      if (chat.ok) return { valid: true, detail: 'Credentials accepted.' };
      if (chat.status === 401 || chat.status === 403) {
        return { valid: false, detail: 'Credentials rejected by provider (HTTP 401/403).' };
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
