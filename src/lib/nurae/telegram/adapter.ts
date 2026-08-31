/**
 * NURAE — Telegram channel adapter (spec §9).
 *
 * The ONLY channel implemented in this release. Speaks the raw Telegram Bot
 * API over HTTPS (no third-party dependency): long-polling getUpdates for
 * inbound messages, sendMessage for outbound replies.
 *
 * Future channels (Discord/WhatsApp/Web) will implement the same logical
 * surface (ChannelAdapter), keeping the runtime channel-agnostic.
 */

export interface TelegramBotInfo {
  id: number;
  username?: string;
  first_name?: string;
  can_join_groups?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    chat: { id: number; type: string; title?: string; first_name?: string; username?: string };
    date: number;
    text?: string;
  };
}

export type TelegramErrorCode =
  | 'invalid_token'
  | 'conflict'
  | 'rate_limited'
  | 'api_error'
  | 'network_error'
  | 'timeout';

export class TelegramApiError extends Error {
  readonly code: TelegramErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: TelegramErrorCode,
    message: string,
    opts?: { retryable?: boolean; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
}

export interface TelegramAdapterOptions {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Long-poll timeout passed to Telegram (seconds). */
  pollTimeoutSec?: number;
  /** Overall HTTP timeout per call (ms). */
  requestTimeoutMs?: number;
}

const DEFAULT_API_BASE = 'https://api.telegram.org';

interface ApiResult<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramAdapter {
  readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSec: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: TelegramAdapterOptions) {
    this.token = opts.token;
    this.apiBase = (opts.apiBase || process.env.NURAE_TELEGRAM_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 35_000;
  }

  private async call<T>(
    method: string,
    body?: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onOuterAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      let json: ApiResult<T>;
      try {
        json = (await res.json()) as ApiResult<T>;
      } catch {
        throw new TelegramApiError('api_error', `Telegram returned a non-JSON response (HTTP ${res.status})`, {
          status: res.status,
          retryable: res.status >= 500,
        });
      }

      if (!json.ok) {
        const description = json.description || `Telegram API error ${json.error_code ?? ''}`.trim();
        const status = json.error_code ?? res.status;
        if (status === 401 || status === 404) {
          throw new TelegramApiError('invalid_token', 'Telegram rejected the bot token (401 Unauthorized). Check the token.');
        }
        if (status === 409) {
          throw new TelegramApiError(
            'conflict',
            'Telegram conflict (409): another getUpdates/webhook session is active for this bot.',
          );
        }
        if (status === 429) {
          throw new TelegramApiError('rate_limited', `Telegram rate limit (429): ${description}`, {
            retryable: true,
            retryAfterMs: (json.parameters?.retry_after ?? 1) * 1000,
            status,
          });
        }
        throw new TelegramApiError('api_error', description, {
          status,
          retryable: status >= 500,
        });
      }
      return json.result as T;
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        throw new TelegramApiError('timeout', 'Telegram request timed out', { retryable: true });
      }
      throw new TelegramApiError('network_error', `Network error contacting Telegram: ${message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Verify identity + token. Returns the bot profile (getMe). */
  async getMe(opts?: { signal?: AbortSignal }): Promise<TelegramBotInfo> {
    return this.call<TelegramBotInfo>('getMe', undefined, opts);
  }

  /** Remove any active webhook so getUpdates can run (avoids 409). */
  async deleteWebhook(opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<boolean>('deleteWebhook', { drop_pending_updates: false }, opts);
  }

  /** Register the webhook Telegram should POST updates to (webhook transport). */
  async setWebhook(
    url: string,
    opts?: { secretToken?: string; dropPendingUpdates?: boolean; allowedUpdates?: string[]; signal?: AbortSignal },
  ): Promise<boolean> {
    return this.call<boolean>(
      'setWebhook',
      {
        url,
        secret_token: opts?.secretToken,
        drop_pending_updates: opts?.dropPendingUpdates ?? false,
        allowed_updates: opts?.allowedUpdates ?? ['message'],
      },
      opts,
    );
  }

  /** Current Telegram-side webhook state (used for status reconciliation). */
  async getWebhookInfo(opts?: { signal?: AbortSignal }): Promise<WebhookInfo> {
    return this.call<WebhookInfo>('getWebhookInfo', undefined, opts);
  }

  /** One long-poll round of getUpdates. */
  async getUpdates(
    offset: number,
    opts?: { signal?: AbortSignal },
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: this.pollTimeoutSec, allowed_updates: ['message'] },
      opts,
    );
  }

  /** Send a plain-text message. Throws TelegramApiError on failure. */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyToMessageId?: number; signal?: AbortSignal },
  ): Promise<void> {
    await this.call<unknown>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        reply_to_message_id: opts?.replyToMessageId,
        // Plain text for this release: no parse_mode, no injection surface.
      },
      opts,
    );
  }
}
