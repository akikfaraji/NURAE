/**
 * NURAE — transport-agnostic bot pipeline (spec Steps 2, 4, 9, 11 + this
 * release: custom commands, inline buttons, callback queries, keyword and
 * fallback replies, mini-workflows, media-with-caption inbound).
 *
 * The SAME message flow serves every transport (webhook today, polling for
 * local development — and the /bots test console via CapturingSender):
 *
 *   Telegram → Telegram Adapter → handleBotMessage()
 *     → menu-command / custom-command / keyword / button routing
 *     → reply workflows (messages with optional inline keyboards)
 *     → conversation context (memory window)
 *     → AI Provider interface → selected provider
 *     → response → Telegram
 *
 * The pipeline never knows how updates arrived. It only needs a bot record,
 * a sender (MessageSender), and a store. All log writes carry structured
 * event codes and pass through the sanitizer — secrets can never reach
 * storage. Capability configs are validated at load time (store.getBot), so
 * a poisoned row cannot inject arbitrary behavior here.
 */

import { TelegramApiError, type OutboundButtons, type TelegramAdapter } from '../telegram/adapter';
import {
  chunkTelegramMessage,
  telegramHtmlFromMarkdown,
} from '../telegram/markdown';
import { selectProvider } from '../ai/registry';
import { AIError, ChatMessage } from '../ai/types';
import type { RuntimeBotRecord, RuntimeStore } from './store';
import type { BotReplySpec, BotCommandSpec, BotCapabilities } from '../bots/capabilities';

// ---------------------------------------------------------------------------
// Sender surface
// ---------------------------------------------------------------------------

/** The outbound surface the pipeline needs. Fakes implement this directly. */
export interface MessageSender {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyToMessageId?: number; signal?: AbortSignal; parseMode?: 'HTML'; buttons?: OutboundButtons },
  ): Promise<void>;
  answerCallbackQuery?(
    callbackQueryId: string,
    opts?: { text?: string; signal?: AbortSignal },
  ): Promise<void>;
}

/** Captured outbound traffic — powers the /bots test console. */
export interface CapturedSend {
  text: string;
  parseMode?: 'HTML';
  buttons?: OutboundButtons;
}

export interface CapturingSender extends MessageSender {
  sends: CapturedSend[];
  answers: Array<{ callbackQueryId: string; text?: string }>;
}

export function capturingSender(): CapturingSender {
  const sender: CapturingSender = {
    sends: [],
    answers: [],
    async sendMessage(_chatId, text, opts) {
      sender.sends.push({
        text,
        parseMode: opts?.parseMode,
        buttons: opts?.buttons,
      });
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      sender.answers.push({ callbackQueryId, text: opts?.text });
    },
  };
  return sender;
}

export interface PipelineDeps {
  store: RuntimeStore;
  providerSelector?: typeof selectProvider;
  /** Cooperative cancellation (bot stopped / request aborted). */
  signal?: AbortSignal | null;
}

export interface InboundMessage {
  chatId: string;
  text: string;
  fromBot: boolean;
  /** Sender display name (used only in logs, never persisted as PII beyond this). */
  fromName?: string;
  /** True when the original update carried a photo (caption-only vision). */
  hasPhoto?: boolean;
}

export interface CallbackMessage {
  chatId: string;
  callbackId: string;
  data: string;
  fromBot?: boolean;
  fromName?: string;
}

// ---------------------------------------------------------------------------
// Built-in texts
// ---------------------------------------------------------------------------

export const START_TEXT = (botName: string) =>
  `${botName} is online ✅\n\nI am an AI assistant powered by NURAE (FRAZIYM TECH & AI).\nSend me any message and I will reply.\nUse /help to see available commands.`;

export function helpText(customCommands: BotCommandSpec[]): string {
  const base =
    'Available commands:\n' +
    '/start — check that the bot is online\n' +
    '/help — show this help';
  const extras = customCommands
    .filter((c) => !['/start', '/help'].includes(c.command.toLowerCase()))
    .map((c) => `${c.command} — ${c.description}`);
  const lines = [base, ...extras].join('\n');
  return `${lines}\n\nAnything else you send is handled by the AI assistant.`;
}

const AI_FAILURE_TEXT: Record<string, string> = {
  invalid_credentials: 'The AI provider rejected the credentials. The bot owner has been notified via logs.',
  missing_credentials: 'The AI provider is not configured yet. Please add an API key in the dashboard.',
  rate_limited: 'The AI provider is rate-limiting requests right now. Please try again in a moment.',
  timeout: 'The AI request timed out. Please try again.',
  provider_not_found: 'The configured AI provider is unknown. Please check the bot configuration.',
  network_error: 'Could not reach the AI provider. Please try again shortly.',
  api_error: 'The AI provider returned an error. Please try again shortly.',
  invalid_response: 'The AI provider returned an unexpected response. Please try again.',
};

// ---------------------------------------------------------------------------
// Command / reply resolution
// ---------------------------------------------------------------------------

/** Normalize a first token into a bare command: "/menu@MyBot" → "/menu". */
function normalizeCommandToken(token: string): string {
  const bare = token.trim().toLowerCase();
  const at = bare.indexOf('@');
  return at === -1 ? bare : bare.slice(0, at);
}

function caps(bot: RuntimeBotRecord): BotCapabilities {
  // Defensive: hand-built records (tests, third-party integrations) may not
  // carry capabilities — they degrade to "no custom capabilities".
  return bot.capabilities ?? { commands: [], replies: [] };
}

function replyWithCommandTrigger(bot: RuntimeBotRecord, command: string): BotReplySpec | undefined {
  return caps(bot).replies.find(
    (r) => r.trigger.type === 'command' && (r.trigger.value ?? '').toLowerCase() === command,
  );
}

function replyForCallback(bot: RuntimeBotRecord, data: string): BotReplySpec | undefined {
  return caps(bot).replies.find(
    (r) => r.trigger.type === 'button' && r.trigger.value === data,
  );
}

function replyForKeyword(bot: RuntimeBotRecord, text: string): BotReplySpec | undefined {
  const lower = text.toLowerCase();
  return caps(bot).replies.find(
    (r) => r.trigger.type === 'keyword' && (r.trigger.value ?? '') && lower.includes(r.trigger.value!.toLowerCase()),
  );
}

function fallbackReply(bot: RuntimeBotRecord): BotReplySpec | undefined {
  return caps(bot).replies.find((r) => r.trigger.type === 'fallback');
}

function buttonsFor(reply: BotReplySpec): OutboundButtons | undefined {
  const first = reply.messages[0];
  if (!first?.buttons?.length) return undefined;
  return first.buttons;
}

// ---------------------------------------------------------------------------
// Text message pipeline
// ---------------------------------------------------------------------------

/** Process one inbound Telegram text message for one bot. Never throws. */
export async function handleBotMessage(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  msg: InboundMessage,
  deps: PipelineDeps,
): Promise<void> {
  const { store } = deps;
  if (msg.fromBot) return; // ignore bots to avoid reply loops
  const trimmed = msg.text.trim();
  if (!trimmed) return;

  // --- Command routing ----------------------------------------------------
  if (trimmed.startsWith('/')) {
    const command = normalizeCommandToken(trimmed.split(/\s+/)[0]);

    // Deep-link payloads: "/start ref_xyz" — acknowledged, logged, welcome sent.
    if (command === '/start') {
      const payload = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
      if (payload && payload !== trimmed) {
        await store.createLog(
          bot.id,
          'info',
          `Deep-link start payload received (chat ${msg.chatId}): ${payload.slice(0, 64)}`,
          'DEEPLINK_START',
        );
      }
      await sendSafely(bot.id, sender, msg.chatId, START_TEXT(bot.name), store, deps.signal);
      return;
    }

    // Custom menu command (static): the owner's text wins over built-ins.
    const custom = caps(bot).commands.find((c) => c.command.toLowerCase() === command);
    if (custom && custom.kind === 'static' && custom.response.trim()) {
      await sendMarkdownReply(
        bot.id,
        sender,
        msg.chatId,
        [{ text: custom.response }],
        store,
        deps.signal,
      );
      return;
    }

    // Reply rule bound to this command (buttons/workflows on /commands).
    const rule = replyWithCommandTrigger(bot, command);
    if (rule) {
      await sendMarkdownReply(bot.id, sender, msg.chatId, rule.messages, store, deps.signal);
      return;
    }

    if (command === '/help') {
      await sendSafely(bot.id, sender, msg.chatId, helpText(caps(bot).commands), store, deps.signal);
      return;
    }

    // Unknown command → owner's fallback reply or the classic hint.
    const fb = fallbackReply(bot);
    if (fb) {
      await sendMarkdownReply(bot.id, sender, msg.chatId, fb.messages, store, deps.signal);
      return;
    }
    await sendSafely(
      bot.id,
      sender,
      msg.chatId,
      `Unknown command "${trimmed.split(/\s+/)[0]}".\n\n${helpText(caps(bot).commands)}`,
      store,
      deps.signal,
    );
    return;
  }

  // --- Keyword-triggered replies -------------------------------------------
  const keywordReply = replyForKeyword(bot, trimmed);
  if (keywordReply) {
    await sendMarkdownReply(bot.id, sender, msg.chatId, keywordReply.messages, store, deps.signal);
    return;
  }

  // --- Fallback reply for free text (when configured) ----------------------
  const fb = fallbackReply(bot);
  if (fb) {
    await sendMarkdownReply(bot.id, sender, msg.chatId, fb.messages, store, deps.signal);
    return;
  }

  // --- AI pipeline ----------------------------------------------------------
  // 1. Persist user turn, 2. build context window, 3. call provider,
  // 4. persist assistant turn, 5. trim memory, 6. deliver reply.
  const noteForAI = msg.hasPhoto
    ? `${trimmed}\n\n(The user sent this together with a photo. NURAE reads the caption text only.)`
    : trimmed;
  await store.appendUserMessage(bot.id, msg.chatId, noteForAI);
  const history = await store.getRecentMessages(bot.id, msg.chatId, bot.memorySize);
  const messages: ChatMessage[] = [{ role: 'system', content: bot.systemPrompt }, ...history];

  let reply: string;
  try {
    const selector = deps.providerSelector ?? selectProvider;
    const selection = selector(bot.provider, {
      apiKey: bot.apiKey,
      baseUrl: bot.baseUrl,
    });
    if (selection.info.requiresKey && !selection.apiKey) {
      throw new AIError('missing_credentials', `No API key configured for provider "${selection.info.id}".`);
    }
    await store.createLog(
      bot.id,
      'info',
      `AI request → provider=${selection.info.id} model=${bot.model} context=${messages.length} msgs.`,
      'AI_REQUEST',
    );
    reply = await selection.provider.generate(messages, {
      model: bot.model,
      temperature: bot.temperature,
      maxTokens: bot.maxTokens,
      apiKey: selection.apiKey,
      baseUrl: selection.baseUrl,
      signal: deps.signal ?? undefined,
    });
    await store.createLog(bot.id, 'info', `AI response received (${reply.length} chars).`, 'AI_RESPONSE');
  } catch (err) {
    const aiErr = err instanceof AIError ? err : null;
    const message = aiErr ? `${aiErr.code}: ${aiErr.message}` : err instanceof Error ? err.message : String(err);
    await store.createLog(bot.id, 'error', `AI request failed — ${message}`, 'AI_REQUEST_FAILED');
    const friendly = AI_FAILURE_TEXT[aiErr?.code ?? 'api_error'] ?? AI_FAILURE_TEXT.api_error;
    await sendSafely(bot.id, sender, msg.chatId, `⚠️ ${friendly}`, store, deps.signal);
    return;
  }

  await store.appendAssistantMessage(bot.id, msg.chatId, reply);
  if (bot.memorySize > 0) {
    await store.trimConversation(bot.id, msg.chatId, bot.memorySize);
  }
  await sendMarkdownReply(bot.id, sender, msg.chatId, [{ text: reply }], store, deps.signal);
}

// ---------------------------------------------------------------------------
// Callback (inline button press) pipeline
// ---------------------------------------------------------------------------

/** Process one callback query for one bot. Never throws. */
export async function handleBotCallback(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  cb: CallbackMessage,
  deps: PipelineDeps,
): Promise<void> {
  const { store } = deps;
  if (cb.fromBot) return;

  const rule = replyForCallback(bot, cb.data);
  if (!rule) {
    await store.createLog(
      bot.id,
      'warn',
      `Button press with unknown callback data "${cb.data.slice(0, 64)}" (chat ${cb.chatId}).`,
      'BUTTON_UNKNOWN',
    );
    await answerSafely(bot.id, sender, cb.callbackId, 'This button is no longer wired up.');
    return;
  }

  await store.createLog(
    bot.id,
    'info',
    `Button "${rule.name}" pressed (chat ${cb.chatId}) — sending ${rule.messages.length} message(s).`,
    'BUTTON_PRESSED',
  );
  await answerSafely(bot.id, sender, cb.callbackId);
  await sendMarkdownReply(bot.id, sender, cb.chatId, rule.messages, store, deps.signal);
}

// ---------------------------------------------------------------------------
// Update mapping
// ---------------------------------------------------------------------------

/** Map a raw Telegram update into a pipeline message (transport helper). */
export function updateToInboundMessage(update: TelegramUpdateLike): InboundMessage | null {
  const message = update.message;
  if (!message) return null;
  // Media: photo messages carry the caption; text-only otherwise. NURAE does
  // not run vision models — captions are read, pixels are not (documented).
  if (typeof message.text === 'string') {
    return {
      chatId: String(message.chat.id),
      text: message.text,
      fromBot: message.from?.is_bot ?? false,
      fromName: message.from?.username,
      hasPhoto: false,
    };
  }
  if (message.photo?.length && typeof message.caption === 'string') {
    return {
      chatId: String(message.chat.id),
      text: message.caption,
      fromBot: message.from?.is_bot ?? false,
      fromName: message.from?.username,
      hasPhoto: true,
    };
  }
  return null;
}

/** Extract a callback query from a raw update (null when not a callback). */
export function updateToCallback(update: TelegramUpdateLike): CallbackMessage | null {
  const cq = update.callback_query;
  if (!cq) return null;
  return {
    chatId: String(cq.message?.chat?.id ?? cq.from?.id ?? 0),
    callbackId: cq.id,
    data: typeof cq.data === 'string' ? cq.data : '',
    fromBot: cq.from?.is_bot ?? false,
    fromName: cq.from?.username,
  };
}

/** Structural subset of the Telegram update type (keeps imports light). */
export interface TelegramUpdateLike {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    chat: { id: number; type: string; title?: string; first_name?: string; username?: string };
    date: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
  };
  callback_query?: {
    id: string;
    from?: { id: number; is_bot: boolean; username?: string };
    message?: { chat?: { id: number; type?: string } };
    data?: string;
  };
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

async function sendSafely(
  botId: string,
  sender: MessageSender,
  chatId: string,
  text: string,
  store: RuntimeStore,
  signal?: AbortSignal | null,
): Promise<void> {
  try {
    await sender.sendMessage(chatId, text, { signal: signal ?? undefined });
    await store.createLog(botId, 'info', `Message sent to chat ${chatId} (${text.length} chars).`, 'TELEGRAM_MESSAGE_SENT');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await store.createLog(botId, 'warn', `Telegram send failed for chat ${chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
  }
}

async function answerSafely(
  botId: string,
  sender: MessageSender,
  callbackId: string,
  text?: string,
): Promise<void> {
  if (!sender.answerCallbackQuery) return; // test fake without callbacks
  try {
    await sender.answerCallbackQuery(callbackId, { text });
  } catch (err) {
    void botId;
    void err; // callback answers are cosmetic — never fail the flow
  }
}

interface ReplyMessage {
  text: string;
  buttons?: OutboundButtons;
}

/**
 * Deliver one or more reply messages (a mini workflow when >1): each message
 * is markdown → Telegram HTML (bold/code/links render), split into
 * ≤4096-char chunks, with the first chunk carrying the inline keyboard —
 * and a plain-text retry when Telegram rejects the entity markup.
 */
async function sendMarkdownReply(
  botId: string,
  sender: MessageSender,
  chatId: string,
  replyMessages: ReplyMessage[],
  store: RuntimeStore,
  signal?: AbortSignal | null,
): Promise<void> {
  for (const [index, message] of replyMessages.entries()) {
    const chunks = chunkTelegramMessage(message.text);
    for (const [ci, chunk] of chunks.entries()) {
      const html = telegramHtmlFromMarkdown(chunk);
      const buttons: OutboundButtons | undefined =
        index === 0 && ci === 0 ? message.buttons : undefined;
      try {
        await sender.sendMessage(chatId, html, {
          signal: signal ?? undefined,
          parseMode: 'HTML',
          buttons,
        });
      } catch (err) {
        if (err instanceof TelegramApiError && err.status === 400) {
          // Telegram refused the entity markup (should not happen — the
          // converter only emits balanced escaped HTML) — degrade to plain.
          await store.createLog(
            botId,
            'warn',
            `Telegram rejected HTML entities for chat ${chatId}; resending as plain text.`,
            'TELEGRAM_HTML_FALLBACK',
          );
          try {
            await sender.sendMessage(chatId, chunk, { signal: signal ?? undefined, buttons });
          } catch (fallbackErr) {
            const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            await store.createLog(botId, 'warn', `Telegram send failed for chat ${chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
          }
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          await store.createLog(botId, 'warn', `Telegram send failed for chat ${chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
        }
      }
    }
  }
  await store.createLog(
    botId,
    'info',
    `Reply delivered to chat ${chatId} (${replyMessages.length} message(s)).`,
    'TELEGRAM_MESSAGE_SENT',
  );
}
