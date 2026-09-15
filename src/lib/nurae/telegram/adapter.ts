/**
 * NURAE — Telegram channel adapter (spec §9).
 *
 * The ONLY channel implemented in this release. Speaks the raw Telegram Bot
 * API over HTTPS (no third-party dependency): long-polling getUpdates for
 * inbound messages, the messaging surface for outbound replies.
 *
 * Outbound surface (2026 platform state, sized for the blueprint library):
 *   text (HTML/markdown-converted, inline OR reply keyboards, force-reply),
 *   media (photo/video/audio/voice/animation/document/sticker by URL or
 *   file_id, albums), polls/quiz, locations, Stars invoices, inline-mode
 *   answers, edit-in-place, chat actions (typing…), profile (name/description).
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

/**
 * Every update family NURAE can act on. Telegram only delivers an update
 * type when it is listed here — new families MUST be added or they silently
 * never arrive (verified platform rule).
 */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'inline_query',
  'pre_checkout_query',
  'my_chat_member',
  'chat_member',
  'poll_answer',
] as const;

/** Inline keyboard shape used by bot replies (rows of buttons). */
export interface OutboundButton {
  text: string;
  url?: string;
  callback?: string;
  /** Opens a Mini App (web_app button) — HTTPS URL. */
  webapp?: string;
  /** copy_text button — copies the given text when pressed (Bot API 7.11). */
  copy?: string;
}
export type OutboundButtons = OutboundButton[][];

type TgButton = { text: string; url?: string; callback_data?: string; web_app?: { url: string }; copy_text?: { text: string } };

function toTelegramKeyboard(buttons: OutboundButtons): TgButton[][] {
  return buttons.map((row) =>
    row.map((b) => {
      const base: TgButton = { text: b.text };
      if (b.callback) return { ...base, callback_data: b.callback };
      if (b.webapp) return { ...base, web_app: { url: b.webapp } };
      if (b.copy) return { ...base, copy_text: { text: b.copy } };
      return { ...base, url: b.url ?? 'https://t.me' };
    }),
  );
}

/** Reply-keyboard button: the label is sent back as a normal text message. */
export interface ReplyKeyboardOptions {
  rows: string[][];
  /** One-time keyboard — Telegram hides it after the next press. */
  oneTime?: boolean;
  placeholder?: string;
}

type ReplyMarkup =
  | { inline_keyboard: TgButton[][] }
  | { keyboard: Array<Array<{ text: string }>>; is_persistent?: boolean; input_field_placeholder?: string }
  | { force_reply: true; input_field_placeholder?: string }
  | { remove_keyboard: true };

export type MediaKind = 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'document' | 'sticker';

const MEDIA_METHOD: Record<MediaKind, string> = {
  photo: 'sendPhoto',
  video: 'sendVideo',
  audio: 'sendAudio',
  voice: 'sendVoice',
  animation: 'sendAnimation',
  document: 'sendDocument',
  sticker: 'sendSticker',
};

/** Media kinds that accept a caption + reply markup (sticker does neither). */
function mediaSupportsCaption(kind: MediaKind): boolean {
  return kind !== 'sticker';
}

export interface OutboundMedia {
  kind: MediaKind;
  /** HTTPS URL or a previously seen Telegram file_id (persistent per bot). */
  source: string;
  caption?: string;
  filename?: string;
}

export interface OutboundPoll {
  question: string;
  options: string[];
  quiz?: boolean;
  /** Zero-based index of the correct option (quiz only). */
  correctOption?: number;
  explanation?: string;
  anonymous?: boolean;
}

export interface OutboundInvoice {
  title: string;
  description: string;
  /** Price in Telegram Stars (XTR) — the mandatory rail for digital goods. */
  priceStars: number;
  payload: string;
}

export interface InlineQueryResult {
  id: string;
  title: string;
  /** Markdown/plain body — converted to Telegram HTML for input_message_content. */
  body: string;
  description?: string;
}

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'upload_video'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location';

export interface SendOptions {
  replyToMessageId?: number;
  signal?: AbortSignal;
  parseMode?: 'HTML';
  buttons?: OutboundButtons;
  /** Render `buttons` as a reply keyboard instead of an inline keyboard. */
  keyboard?: 'reply' | 'inline' | 'none';
  forceReply?: boolean;
  /** Send ReplyKeyboardRemove (clears a previous reply keyboard). */
  removeKeyboard?: boolean;
  /** The reply keyboard itself (labels the user taps, sent back as text). */
  replyKeyboard?: ReplyKeyboardOptions;
  /** Disable the link preview even in plain-text mode. */
  disablePreview?: boolean;
}

function replyMarkupFor(opts: SendOptions): ReplyMarkup | undefined {
  if (opts.removeKeyboard) return { remove_keyboard: true };
  if (opts.replyKeyboard?.rows?.length) {
    return {
      keyboard: opts.replyKeyboard.rows.slice(0, 8).map((row) => row.slice(0, 8).map((text) => ({ text: text.slice(0, 64) }))),
      ...(opts.replyKeyboard.oneTime ? { is_persistent: false } : {}),
      ...(opts.replyKeyboard.placeholder ? { input_field_placeholder: opts.replyKeyboard.placeholder.slice(0, 64) } : {}),
    };
  }
  if (opts.forceReply) return { force_reply: true };
  if (opts.buttons?.length && opts.keyboard !== 'none') {
    return { inline_keyboard: toTelegramKeyboard(opts.buttons) };
  }
  return undefined;
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

  /**
   * Membership status of a user in a chat (getChatMember) — one of
   * creator | administrator | member | restricted | left | kicked.
   * Powers join-gate behaviors: the bot verifies a user joined the
   * configured channel/group before continuing a flow. Requires the bot
   * to be a member/admin of the target chat; Telegram returns an error
   * otherwise (callers treat any failure as fail-open).
   */
  async getChatMember(
    chatRef: string,
    userId: number,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const res = await this.call<{ status?: string }>(
      'getChatMember',
      { chat_id: chatRef, user_id: userId },
      opts,
    );
    return res.status ?? 'left';
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
        allowed_updates: opts?.allowedUpdates ?? [...ALLOWED_UPDATES],
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
      { offset, timeout: this.pollTimeoutSec, allowed_updates: [...ALLOWED_UPDATES] },
      opts,
    );
  }

  /**
   * Send a text message. Throws TelegramApiError on failure.
   * With `parseMode: 'HTML'` the text must already be Telegram-HTML
   * (see ./markdown.ts); plain mode sends raw text with no parse_mode.
   * `buttons` attaches a keyboard (inline by default; reply with keyboard:'reply'
   * or via replyKeyboard labels); forceReply/removeKeyboard shape the input.
   */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    const markup = replyMarkupFor(opts ?? {});
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
          : opts?.disablePreview
            ? { link_preview_options: { is_disabled: true } }
            : {}),
        ...(markup ? { reply_markup: markup } : {}),
      },
      opts,
    );
  }

  /** Show a chat action status ("typing…") for ~5s — polish for slow turns. */
  async sendChatAction(
    chatId: number | string,
    action: ChatAction,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    try {
      await this.call<unknown>('sendChatAction', { chat_id: chatId, action }, opts);
    } catch {
      // Cosmetic by definition — never fail a turn over a typing indicator.
    }
  }

  /** Send one media item (by URL or file_id) with optional caption + markup. */
  async sendMedia(
    chatId: number | string,
    media: OutboundMedia,
    opts?: SendOptions,
  ): Promise<void> {
    const method = MEDIA_METHOD[media.kind] ?? 'sendPhoto';
    const mediaField = media.kind === 'animation' ? 'animation' : media.kind;
    const withCaption = mediaSupportsCaption(media.kind);
    const markup = replyMarkupFor(opts ?? {});
    await this.call<unknown>(
      method,
      {
        chat_id: chatId,
        [mediaField]: media.source,
        ...(withCaption && media.caption ? { caption: media.caption.slice(0, 1024) } : {}),
        ...(withCaption && opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        ...(opts?.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
      },
      opts,
    );
  }

  /** Send an album (2–10 media items). Reply markup is not supported here. */
  async sendMediaGroup(
    chatId: number | string,
    items: OutboundMedia[],
    opts?: SendOptions,
  ): Promise<void> {
    await this.call<unknown>(
      'sendMediaGroup',
      {
        chat_id: chatId,
        media: items.slice(0, 10).map((m) => ({
          type: m.kind === 'animation' ? 'animation' : m.kind === 'document' ? 'document' : m.kind,
          media: m.source,
          ...(mediaSupportsCaption(m.kind) && m.caption ? { caption: m.caption.slice(0, 1024), parse_mode: opts?.parseMode } : {}),
        })),
      },
      opts,
    );
  }

  /** Send a poll / quiz (options ≤12, question ≤300 chars). */
  async sendPoll(
    chatId: number | string,
    poll: OutboundPoll,
    opts?: SendOptions,
  ): Promise<void> {
    await this.call<unknown>(
      'sendPoll',
      {
        chat_id: chatId,
        question: poll.question.slice(0, 300),
        options: poll.options.slice(0, 12).map((o) => o.slice(0, 100)),
        is_anonymous: poll.anonymous ?? true,
        ...(poll.quiz
          ? {
              type: 'quiz',
              ...(typeof poll.correctOption === 'number' ? { correct_option_id: poll.correctOption } : {}),
              ...(poll.explanation ? { explanation: poll.explanation.slice(0, 200) } : {}),
            }
          : {}),
      },
      opts,
    );
  }

  async sendLocation(
    chatId: number | string,
    location: { latitude: number; longitude: number; title?: string; address?: string },
    opts?: SendOptions,
  ): Promise<void> {
    const isVenue = Boolean(location.title && location.address);
    await this.call<unknown>(
      isVenue ? 'sendVenue' : 'sendLocation',
      {
        chat_id: chatId,
        latitude: location.latitude,
        longitude: location.longitude,
        ...(isVenue ? { title: location.title!.slice(0, 64), address: location.address!.slice(0, 64) } : {}),
      },
      opts,
    );
  }

  async sendContact(
    chatId: number | string,
    contact: { phone: string; firstName: string; lastName?: string },
    opts?: SendOptions,
  ): Promise<void> {
    await this.call<unknown>(
      'sendContact',
      {
        chat_id: chatId,
        phone_number: contact.phone,
        first_name: contact.firstName.slice(0, 64),
        ...(contact.lastName ? { last_name: contact.lastName.slice(0, 64) } : {}),
      },
      opts,
    );
  }

  /**
   * Send a Telegram Stars invoice (digital goods MUST use XTR — store policy).
   * Telegram then sends pre_checkout_query + successful_payment updates.
   */
  async sendInvoice(
    chatId: number | string,
    invoice: OutboundInvoice,
    opts?: SendOptions,
  ): Promise<void> {
    const markup = replyMarkupFor(opts ?? {});
    await this.call<unknown>(
      'sendInvoice',
      {
        chat_id: chatId,
        title: invoice.title.slice(0, 32),
        description: invoice.description.slice(0, 255),
        payload: invoice.payload.slice(0, 128),
        currency: 'XTR',
        prices: [{ label: invoice.title.slice(0, 32), amount: Math.max(1, Math.round(invoice.priceStars)) }],
        ...(markup ? { reply_markup: markup } : {}),
      },
      opts,
    );
  }

  /** Refund a Stars payment (telegram_payment_charge_id from BotPayment). */
  async refundStarPayment(chargeId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<unknown>('refundStarPayment', { telegram_payment_charge_id: chargeId }, opts);
  }

  /**
   * Create a pay-anywhere Stars invoice link (no chat needed — the URL works
   * on the web, in apps, anywhere). Used by the platform topup flow.
   */
  async createInvoiceLink(
    params: { title: string; description: string; payload: string; priceStars: number },
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    return this.call<string>(
      'createInvoiceLink',
      {
        title: params.title.slice(0, 32),
        description: params.description.slice(0, 255),
        payload: params.payload.slice(0, 128),
        currency: 'XTR',
        prices: [{ label: params.title.slice(0, 32), amount: Math.max(1, Math.round(params.priceStars)) }],
      },
      opts,
    );
  }

  /** Approve/deny a pre-checkout query — MUST be answered within 10 seconds. */
  async answerPreCheckoutQuery(
    queryId: string,
    ok: boolean,
    opts?: { errorMessage?: string; signal?: AbortSignal },
  ): Promise<void> {
    await this.call<unknown>(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id: queryId,
        ok,
        ...(ok ? {} : { error_message: (opts?.errorMessage ?? 'Payment could not be completed.').slice(0, 255) }),
      },
      opts,
    );
  }

  /** Answer an inline query (results shown while typing @bot … anywhere). */
  async answerInlineQuery(
    queryId: string,
    results: InlineQueryResult[],
    opts?: { cacheTime?: number; isPersonal?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    await this.call<unknown>(
      'answerInlineQuery',
      {
        inline_query_id: queryId,
        cache_time: opts?.cacheTime ?? 30,
        is_personal: opts?.isPersonal ?? true,
        results: results.slice(0, 20).map((r) => ({
          type: 'article',
          id: r.id.slice(0, 64),
          title: r.title.slice(0, 128),
          description: (r.description ?? '').slice(0, 128),
          input_message_content: {
            message_text: r.body.slice(0, 4096),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          },
        })),
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

  /**
   * Edit a sent message in place (the idiomatic UX for pagination/settings).
   * Pass replyMarkup:false to strip the keyboard; buttons to replace it.
   */
  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: SendOptions & { keepMarkup?: boolean },
  ): Promise<void> {
    const markup = opts?.keepMarkup ? undefined : replyMarkupFor(opts ?? {});
    await this.call<unknown>(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(opts?.parseMode ? { parse_mode: opts.parseMode, link_preview_options: { is_disabled: true } } : {}),
        ...(markup ? { reply_markup: markup } : {}),
      },
      opts,
    );
  }

  async deleteMessage(chatId: number | string, messageId: number, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<unknown>('deleteMessage', { chat_id: chatId, message_id: messageId }, opts);
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

  /** Public bot profile text — shown BEFORE a user starts the bot (≤512). */
  async setMyDescription(description: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<unknown>('setMyDescription', { description: description.slice(0, 512) }, opts);
  }

  /** Short profile line ("bio", ≤120 chars, shown on the bot's profile). */
  async setMyShortDescription(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<unknown>('setMyShortDescription', { short_description: text.slice(0, 120) }, opts);
  }

  /** Bot display name (≤64 chars). */
  async setMyName(name: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.call<unknown>('setMyName', { name: name.slice(0, 64) }, opts);
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
