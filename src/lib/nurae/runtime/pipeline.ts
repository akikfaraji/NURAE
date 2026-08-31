/**
 * NURAE — transport-agnostic bot pipeline (spec Steps 2, 4, 9, 11).
 *
 * The SAME message flow serves every transport (webhook today, polling for
 * local development):
 *
 *   Telegram → Telegram Adapter → handleBotMessage()
 *     → command routing (/start, /help)
 *     → conversation context (memory window)
 *     → AI Provider interface → selected provider
 *     → response → Telegram
 *
 * The pipeline never knows how updates arrived. It only needs a bot record,
 * a sender (sendMessage), and a store. All log writes carry structured event
 * codes and pass through the sanitizer — secrets can never reach storage.
 */

import type { TelegramAdapter } from '../telegram/adapter';
import { selectProvider } from '../ai/registry';
import { AIError, ChatMessage } from '../ai/types';
import type { RuntimeBotRecord, RuntimeStore } from './store';

/** The only Telegram capability the pipeline needs — easy to fake in tests. */
export type MessageSender = Pick<TelegramAdapter, 'sendMessage'>;

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
}

export const START_TEXT = (botName: string) =>
  `${botName} is online ✅\n\nI am an AI assistant powered by NURAE (FRAZIYM TECH & AI).\nSend me any message and I will reply.\nUse /help to see available commands.`;

export const HELP_TEXT =
  'Available commands:\n' +
  '/start — check that the bot is online\n' +
  '/help — show this help\n\n' +
  'Anything else you send is handled by the AI assistant.';

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
  if (trimmed === '/start') {
    await sendSafely(bot.id, sender, msg.chatId, START_TEXT(bot.name), store, deps.signal);
    return;
  }
  if (trimmed === '/help') {
    await sendSafely(bot.id, sender, msg.chatId, HELP_TEXT, store, deps.signal);
    return;
  }
  if (trimmed.startsWith('/')) {
    await sendSafely(
      bot.id,
      sender,
      msg.chatId,
      `Unknown command "${trimmed.split(/\s+/)[0]}".\n\n${HELP_TEXT}`,
      store,
      deps.signal,
    );
    return;
  }

  // --- AI pipeline ----------------------------------------------------------
  // 1. Persist user turn, 2. build context window, 3. call provider,
  // 4. persist assistant turn, 5. trim memory, 6. deliver reply.
  await store.appendUserMessage(bot.id, msg.chatId, trimmed);
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
  await sendSafely(bot.id, sender, msg.chatId, reply, store, deps.signal);
}

/** Map a raw Telegram update into a pipeline message (transport helper). */
export function updateToInboundMessage(update: TelegramUpdateLike): InboundMessage | null {
  const message = update.message;
  if (!message || typeof message.text !== 'string') return null;
  return {
    chatId: String(message.chat.id),
    text: message.text,
    fromBot: message.from?.is_bot ?? false,
    fromName: message.from?.username,
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
  };
}

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
