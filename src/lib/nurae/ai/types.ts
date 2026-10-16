/**
 * NURAE — AI provider abstraction (spec §7, §16).
 *
 * Provider-specific implementations stay isolated behind this interface so
 * adding a provider later does not require rewriting the Telegram system.
 *
 *   AIProvider
 *   ├── openai     (OpenAI-compatible HTTP)
 *   ├── openrouter (OpenAI-compatible HTTP — free models included)
 *   ├── deepseek   (OpenAI-compatible HTTP)
 *   ├── glm        (Zhipu open platform — OpenAI-compatible HTTP)
 *   ├── local      (Ollama / llama.cpp / vLLM — OpenAI-compatible HTTP)
 *   └── custom     (any OpenAI-compatible endpoint)
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIRequestConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  /** Decrypted API key (or null for providers that need none). */
  apiKey?: string | null;
  /** Base URL override for openai-compatible providers. */
  baseUrl?: string | null;
  /** Abort signal for cooperative cancellation (bot stop / shutdown). */
  signal?: AbortSignal;
  /** OpenAI-style function definitions — only honored by generateWithTools(). */
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

/** One native tool call returned by the model (OpenAI function-calling shape). */
export interface AIToolCall {
  name: string;
  /** Raw arguments — usually a JSON string; parsed lazily by the caller. */
  arguments: string | Record<string, unknown>;
}

export interface CredentialCheckResult {
  valid: boolean;
  detail?: string;
}

export interface AIProvider {
  readonly id: string;
  /** Generate a completion for the given message window. */
  generate(messages: ChatMessage[], config: AIRequestConfig): Promise<string>;
  /**
   * Optional streaming variant. The MVP pipeline uses generate(); stream()
   * exists so future channels/UI can adopt streaming without interface churn.
   */
  stream?(messages: ChatMessage[], config: AIRequestConfig): AsyncIterable<string>;
  /**
   * Optional native function-calling round: sends `tools` and returns the
   * model's tool_calls next to its text. Free OpenRouter models frequently
   * emit NATIVE tool_calls that generate() discards (it returns text only) —
   * agent loops that silently lost every such call now prefer this method.
   * When a provider does not implement it, callers fall back to generate()
   * and text-markup parsing.
   */
  generateWithTools?(
    messages: ChatMessage[],
    config: AIRequestConfig,
  ): Promise<{ content: string; toolCalls: AIToolCall[] }>;
  /** Verify credentials/configuration with a minimal, cheap call. */
  validateCredentials(config: Partial<AIRequestConfig>): Promise<CredentialCheckResult>;
}

export type AIErrorCode =
  | 'provider_not_found'
  | 'missing_credentials'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'api_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'policy_blocked';

/** Structured provider error — never carries raw secrets. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: AIErrorCode,
    message: string,
    opts?: { retryable?: boolean; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

/** Map an unknown throw into an AIError with the right classification. */
export function classifyProviderError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return new AIError('timeout', 'AI request timed out', { retryable: true });
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(message)) {
    return new AIError('network_error', `Network error contacting AI provider: ${message}`, {
      retryable: true,
    });
  }
  return new AIError('api_error', message, { retryable: false });
}
