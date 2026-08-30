/**
 * NURAE — built-in GLM provider (zero-config).
 *
 * Uses z-ai-web-dev-sdk under the hood so NURAE works out of the box in the
 * FRAZIYM sandbox without any user-supplied API key. Backend-only import.
 * The SDK instance is created lazily and reused.
 */

import {
  AIError,
  AIProvider,
  AIRequestConfig,
  ChatMessage,
  CredentialCheckResult,
} from '../types';

const DEFAULT_TIMEOUT_MS = 90_000;

interface ZaiCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface ZaiClient {
  chat: {
    completions: {
      create(args: Record<string, unknown>): Promise<ZaiCompletion>;
    };
  };
}

type ZaiFactory = () => Promise<ZaiClient>;

async function defaultFactory(): Promise<ZaiClient> {
  // Dynamic import keeps this module usable in unit tests that mock the SDK.
  const mod = await import('z-ai-web-dev-sdk');
  const ZAI = (mod as { default?: unknown }).default ?? mod;
  const create = (ZAI as { create?: () => Promise<unknown> }).create;
  if (typeof create !== 'function') {
    throw new AIError('api_error', 'z-ai-web-dev-sdk is unavailable in this environment');
  }
  return (await create()) as ZaiClient;
}

export class ZaiProvider implements AIProvider {
  readonly id = 'zai';
  private factory: ZaiFactory;
  private client: ZaiClient | null = null;
  private readonly timeoutMs: number;

  constructor(opts?: { timeoutMs?: number; factory?: ZaiFactory }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.factory = opts?.factory ?? defaultFactory;
  }

  private async getClient(): Promise<ZaiClient> {
    if (!this.client) {
      this.client = await this.factory();
    }
    return this.client;
  }

  private extract(completion: ZaiCompletion): string {
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new AIError('invalid_response', 'Built-in AI returned an empty response');
    }
    return content;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('aborted: timeout exceeded')), this.timeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async generate(messages: ChatMessage[], config: AIRequestConfig): Promise<string> {
    const client = await this.getClient();
    // Try with full generation parameters first; fall back to the minimal
    // documented payload if the SDK build rejects extra fields.
    try {
      const completion = await this.withTimeout(
        client.chat.completions.create({
          messages,
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          thinking: { type: 'disabled' },
        }),
      );
      return this.extract(completion);
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (config.signal?.aborted) {
        throw new AIError('timeout', 'AI request aborted');
      }
      // Fallback: minimal documented payload.
      try {
        const completion = await this.withTimeout(
          client.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        );
        return this.extract(completion);
      } catch (fallbackErr) {
        if (fallbackErr instanceof AIError) throw fallbackErr;
        const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (/abort/i.test(message)) {
          throw new AIError('timeout', 'AI request timed out', { retryable: true });
        }
        throw new AIError('api_error', `Built-in AI request failed: ${message}`);
      }
    }
  }

  async validateCredentials(_config: Partial<AIRequestConfig>): Promise<CredentialCheckResult> {
    try {
      const client = await this.getClient();
      await this.withTimeout(
        client.chat.completions.create({
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
          max_tokens: 8,
          thinking: { type: 'disabled' },
        }),
      );
      return { valid: true, detail: 'Built-in AI reachable.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, detail: `Built-in AI check failed: ${message}` };
    }
  }
}
