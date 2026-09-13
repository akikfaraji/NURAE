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

/** Inline keyboard shape used by bot replies (rows of buttons). */
export interface OutboundButton {
  text: string;
  url?: string;
  callback?: string;
}
export type OutboundButtons = OutboundButton[][];

function toTelegramKeyboard(buttons: OutboundButtons): Array<Array<{ text: string; url?: string; callback_data?: string }>> {
  return buttons.map((row) =>
    row.map((b) =>
      b.callback
        ? { text: b.text, callback_data: b.callback }
        : { text: b.text, url: b.url ?? 'https://t.me' },
    ),
  );
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
        allowed_updates: opts?.allowedUpdates ?? ['message', 'callback_query'],
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
      { offset, timeout: this.pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
      opts,
    );
  }

  /**
   * Send a message. Throws TelegramApiError on failure.
   * With `parseMode: 'HTML'` the text must already be Telegram-HTML
   * (see ./markdown.ts); plain mode sends raw text with no parse_mode.
   * `buttons` attaches an inline keyboard (NURAE bot replies).
   */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts?: {
      replyToMessageId?: number;
      signal?: AbortSignal;
      parseMode?: 'HTML';
      buttons?: OutboundButtons;
    },
  ): Promise<void> {
    await this.call<unknown>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        reply_to_message_id: opts?.replyToMessageId,
        // HTML mode renders AI markdown (bold/code/links); link previews are
        // disabled to keep AI answers compact. Plain mode stays untouched.
        ...(opts?.parseMode
          ? { parse_mode: opts.parseMode, link_preview_options: { is_disabled: true } }
          : {}),
        ...(opts?.buttons?.length
          ? { reply_markup: { inline_keyboard: toTelegramKeyboard(opts.buttons) } }
          : {}),
      },
      opts,
    );
  }

  /** Acknowledge a button press (stops the client spinner, optional toast). */
  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string; signal?: AbortSignal },
  ): Promise<void> {
    await this.call<unknown>(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        ...(opts?.text ? { text: opts.text.slice(0, 200), show_alert: false } : {}),
      },
      opts,
    );
  }

  /** Register the bot menu commands (what Telegram shows in the commands UI). */
  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!commands.length) return;
    await this.call<unknown>(
      'setMyCommands',
      { commands: commands.slice(0, 100) },
      opts,
    );
  }

  /** Resolve a file id to a download path (media handling). */
  async getFile(
    fileId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ file_path?: string }> {
    return this.call<{ file_path?: string }>('getFile', { file_id: fileId }, opts);
  }

  /** Download a file previously resolved via getFile (returns raw bytes). */
  async downloadFile(filePath: string, opts?: { signal?: AbortSignal }): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onOuterAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(
        `${this.apiBase}/file/bot${this.token}/${filePath.replace(/^\//, '')}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        throw new TelegramApiError('api_error', `Telegram file download failed (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;
      throw new TelegramApiError('network_error', `Telegram file download error: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
