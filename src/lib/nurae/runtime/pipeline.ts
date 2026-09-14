/**
 * NURAE — transport-agnostic bot pipeline (spec Steps 2, 4, 9, 11 + the
 * ecosystem release: media, polls, Stars payments, forms with memory,
 * reminders, groups, inline mode, edit-in-place, deep-link routing).
 *
 * The SAME update flow serves every transport (webhook, polling, and the
 * /bots Preview console via CapturingSender):
 *
 *   Telegram → routeBotUpdate() → handleBotMessage / handleBotCallback /
 *              handleInlineQuery / handlePreCheckoutQuery / …
 *     → trigger routing (payload, command, exact-text, keyword, button, join)
 *     → reply workflows (text, media, polls, invoices, collect→resume steps)
 *     → per-user state (attributes, awaiting answers, {{placeholders}})
 *     → conversation context (memory window) → AI provider → reply
 *
 * The pipeline never knows how updates arrived. It needs a bot record, a
 * sender (MessageSender), and a store. All log writes carry structured event
 * codes and pass through the sanitizer. Capability configs are validated at
 * load time (store.getBot), so a poisoned row cannot inject behavior here.
 */

import { TelegramApiError, type ChatAction, type InlineQueryResult, type OutboundButtons, type OutboundInvoice, type OutboundMedia, type OutboundPoll, type SendOptions, type TelegramAdapter } from '../telegram/adapter';
import {
  chunkTelegramMessage,
  telegramHtmlFromMarkdown,
} from '../telegram/markdown';
import { selectProvider } from '../ai/registry';
import { AIError, ChatMessage } from '../ai/types';
import type { RuntimeBotRecord, RuntimeStore, BotUserStateData } from './store';
import type { BotReplySpec, BotCommandSpec, BotCapabilities } from '../bots/capabilities';
import { chargeFeature } from '../billing/wallet';
import { formatUsd, parseTopupPayload } from '../billing/catalog';

// ---------------------------------------------------------------------------
// Sender surface
// ---------------------------------------------------------------------------

/**
 * The outbound surface the pipeline needs. Only sendMessage is required —
 * fakes (and older integrations) implement just it and the pipeline
 * gracefully skips the rest.
 */
export interface MessageSender {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendOptions,
  ): Promise<void>;
  answerCallbackQuery?(
    callbackQueryId: string,
    opts?: { text?: string; signal?: AbortSignal },
  ): Promise<void>;
  sendChatAction?(chatId: number | string, action: ChatAction, opts?: { signal?: AbortSignal }): Promise<void>;
  sendMedia?(chatId: number | string, media: OutboundMedia, opts?: SendOptions): Promise<void>;
  sendPoll?(chatId: number | string, poll: OutboundPoll, opts?: SendOptions): Promise<void>;
  sendInvoice?(chatId: number | string, invoice: OutboundInvoice, opts?: SendOptions): Promise<void>;
  answerPreCheckoutQuery?(queryId: string, ok: boolean, opts?: { errorMessage?: string; signal?: AbortSignal }): Promise<void>;
  answerInlineQuery?(queryId: string, results: InlineQueryResult[], opts?: { cacheTime?: number; isPersonal?: boolean; signal?: AbortSignal }): Promise<void>;
  editMessageText?(chatId: number | string, messageId: number, text: string, opts?: SendOptions): Promise<void>;
}

/** Captured outbound traffic — powers the /bots Preview console. */
export interface CapturedSend {
  kind?: 'text' | 'media' | 'poll' | 'payment' | 'edit';
  text: string;
  parseMode?: 'HTML';
  buttons?: OutboundButtons;
  keyboard?: 'reply' | 'inline' | 'none';
  media?: OutboundMedia;
  poll?: OutboundPoll;
  payment?: OutboundInvoice;
}

export interface CapturingSender extends MessageSender {
  sends: CapturedSend[];
  answers: Array<{ callbackQueryId: string; text?: string }>;
  chatActions: Array<{ chatId: string; action: ChatAction }>;
  inlineAnswers: Array<{ queryId: string; results: InlineQueryResult[] }>;
  preCheckoutAnswers: Array<{ queryId: string; ok: boolean }>;
  edits: Array<{ chatId: string; messageId: number; text: string }>;
}

export function capturingSender(): CapturingSender {
  const sender: CapturingSender = {
    sends: [],
    answers: [],
    chatActions: [],
    inlineAnswers: [],
    preCheckoutAnswers: [],
    edits: [],
    async sendMessage(_chatId, text, opts) {
      sender.sends.push({
        kind: 'text',
        text,
        parseMode: opts?.parseMode,
        buttons: opts?.buttons,
        keyboard: opts?.keyboard,
      });
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      sender.answers.push({ callbackQueryId, text: opts?.text });
    },
    async sendChatAction(chatId, action) {
      sender.chatActions.push({ chatId: String(chatId), action });
    },
    async sendMedia(_chatId, media, opts) {
      sender.sends.push({
        kind: 'media',
        text: media.caption ?? '',
        parseMode: opts?.parseMode,
        buttons: opts?.buttons,
        media,
      });
    },
    async sendPoll(_chatId, poll) {
      sender.sends.push({ kind: 'poll', text: poll.question, poll });
    },
    async sendInvoice(_chatId, invoice) {
      sender.sends.push({ kind: 'payment', text: invoice.title, payment: invoice });
    },
    async answerPreCheckoutQuery(queryId, ok) {
      sender.preCheckoutAnswers.push({ queryId, ok });
    },
    async answerInlineQuery(queryId, results) {
      sender.inlineAnswers.push({ queryId, results });
    },
    async editMessageText(chatId, messageId, text, opts) {
      sender.edits.push({ chatId: String(chatId), messageId, text });
      sender.sends.push({
        kind: 'edit',
        text,
        parseMode: opts?.parseMode,
        buttons: opts?.buttons,
      });
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
  /** First name as Telegram reports it — used for {{name}} and join greetings. */
  fromFirstName?: string;
  /** Private | group | supergroup | channel — drives group gating. */
  chatType?: string;
  /** True when the text mentions @this_bot (free text in groups needs it). */
  mentionsBot?: boolean;
  /** The bot's own @username (command @-suffix disambiguation). */
  botUsername?: string;
  /** True when the original update carried a photo (caption-only vision). */
  hasPhoto?: boolean;
  /** Service message kinds the pipeline routes itself. */
  service?: 'member_joined' | 'payment';
  /** member_joined: display names of the people who joined. */
  joinedNames?: string[];
  /** payment: the successful_payment payload. */
  paymentInfo?: {
    chargeId: string;
    amount: number;
    currency: string;
    payload: string;
  };
}

export interface CallbackMessage {
  chatId: string;
  callbackId: string;
  data: string;
  fromBot?: boolean;
  fromName?: string;
  /** First name as Telegram reports it — draws/leaderboards greet people. */
  fromFirstName?: string;
  /** The message the button was attached to (edit-in-place). */
  messageId?: number;
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

/** Split "/cmd@BotName rest" → { command: "/cmd", aimedAt: "botname", rest }. */
function parseCommandToken(text: string): { command: string; aimedAt: string | null; rest: string } {
  const first = text.trim().split(/\s+/)[0];
  const bare = first.toLowerCase();
  const at = bare.indexOf('@');
  const command = at === -1 ? bare : bare.slice(0, at);
  const aimedAt = at === -1 ? null : bare.slice(at + 1);
  const rest = text.trim().slice(first.length).trim();
  return { command, aimedAt, rest };
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

function replyForExactText(bot: RuntimeBotRecord, text: string): BotReplySpec | undefined {
  const lower = text.trim().toLowerCase();
  return caps(bot).replies.find(
    (r) => r.trigger.type === 'text' && (r.trigger.value ?? '').toLowerCase() === lower,
  );
}

function replyForPayload(bot: RuntimeBotRecord, payload: string): BotReplySpec | undefined {
  const lower = payload.toLowerCase();
  return caps(bot).replies.find(
    (r) =>
      r.trigger.type === 'payload' &&
      (r.trigger.value ?? '') &&
      (lower === r.trigger.value!.toLowerCase() || lower.startsWith(`${r.trigger.value!.toLowerCase()}`)),
  );
}

function replyForMemberJoined(bot: RuntimeBotRecord): BotReplySpec | undefined {
  return caps(bot).replies.find((r) => r.trigger.type === 'member_joined');
}

function fallbackReply(bot: RuntimeBotRecord): BotReplySpec | undefined {
  return caps(bot).replies.find((r) => r.trigger.type === 'fallback');
}

// ---------------------------------------------------------------------------
// Per-user state helpers
// ---------------------------------------------------------------------------

/** State is an optimization-friendly cache — a failed read must never break a turn. */
async function readState(store: RuntimeStore, botId: string, chatId: string): Promise<BotUserStateData | null> {
  try {
    return await store.getUserState(botId, chatId);
  } catch {
    return null;
  }
}

/** Same rule for writes: a broken/missing store must not fail the user's turn. */
async function patchState(
  store: RuntimeStore,
  botId: string,
  chatId: string,
  patch: Parameters<RuntimeStore['updateUserState']>[2],
): Promise<void> {
  try {
    await store.updateUserState(botId, chatId, patch);
  } catch {
    /* per-user state is optional — the bot keeps working without it */
  }
}

/**
 * {{placeholders}}: attributes (collected answers, carts, progress) plus the
 * builtins {{name}}, {{username}}, {{chat_id}}, {{bot_username}}. A placeholder
 * may carry a fallback — "{{score|0}}" renders 0 until score exists. Unknown
 * keys without a fallback stay visible — honest debugging for the owner,
 * never silent data loss.
 */
function applyTemplate(
  text: string,
  state: BotUserStateData | null,
  msg: { fromName?: string; fromFirstName?: string; chatId: string; botUsername?: string },
): string {
  if (!text.includes('{{')) return text;
  const attrs = state?.attributes ?? {};
  return text.replace(/\{\{\s*([a-zA-Z0-9_-]{1,40})\s*(?:\|\s*([^{}]{1,200}?)\s*)?\}\}/g, (whole, key: string, fallback?: string) => {
    if (key === 'name') return msg.fromFirstName || msg.fromName || 'there';
    if (key === 'username') return msg.fromName ? `@${msg.fromName}` : '';
    if (key === 'chat_id') return msg.chatId;
    if (key === 'bot_username') {
      // Stored with the leading @ — links want the bare form.
      const bare = msg.botUsername?.replace(/^@/, '');
      return bare || fallback || whole;
    }
    if (key in attrs) return attrs[key];
    if (fallback !== undefined) return fallback;
    return whole;
  });
}

function userContextBlock(state: BotUserStateData | null): string {
  if (!state) return '';
  const entries = Object.entries(state.attributes).filter(([k]) => !k.startsWith('_'));
  if (!entries.length && !state.startPayload) return '';
  const lines = [
    ...entries.slice(0, 20).map(([k, v]) => `${k}: ${v}`),
    ...(state.startPayload ? [`arrived_via: ${state.startPayload}`] : []),
  ];
  return `\n\n[Known about this user]\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Text message pipeline
// ---------------------------------------------------------------------------

/** Process one inbound Telegram message for one bot. Never throws. */
export async function handleBotMessage(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  msg: InboundMessage,
  deps: PipelineDeps,
): Promise<void> {
  const { store } = deps;
  if (msg.fromBot) return; // ignore bots to avoid reply loops

  const ctx: TurnContext = {
    chatId: msg.chatId,
    fromName: msg.fromName,
    fromFirstName: msg.fromFirstName,
    botUsername: bot.telegramUsername ?? undefined,
  };
  const state = await readState(store, bot.id, msg.chatId);
  // Remember the display name — draws and leaderboards greet people, not ids.
  const displayName = msg.fromFirstName || msg.fromName;
  await patchState(store, bot.id, msg.chatId, {
    touch: true,
    ...(displayName ? { attributes: { name: displayName.slice(0, 64) } } : {}),
  });

  // --- Service messages ----------------------------------------------------
  if (msg.service === 'member_joined') {
    const rule = replyForMemberJoined(bot);
    if (!rule) return; // no welcome configured — silence is correct
    await store.createLog(bot.id, 'info', `New member(s) joined (chat ${msg.chatId}) — welcome sent.`, 'MEMBER_JOINED');
    // Greet the joiner by name ({{name}}), not the actor who triggered it.
    const joinCtx: TurnContext = {
      ...ctx,
      fromFirstName: msg.joinedNames?.[0] ?? ctx.fromFirstName,
    };
    await executeReplyMessages(bot, sender, rule.messages, rule.id, 0, joinCtx, state, store, deps.signal, deps.providerSelector);
    return;
  }
  if (msg.service === 'payment' && msg.paymentInfo) {
    await handleSuccessfulPayment(bot, sender, msg, state, store, deps.signal);
    return;
  }

  const trimmed = msg.text.trim();
  if (!trimmed) return;
  const isGroup = msg.chatType === 'group' || msg.chatType === 'supergroup';

  // --- Command routing ----------------------------------------------------
  if (trimmed.startsWith('/')) {
    const { command, aimedAt, rest } = parseCommandToken(trimmed);
    // "/menu@SomeOtherBot" is aimed at a different bot — never answer it.
    if (aimedAt && msg.botUsername && aimedAt.toLowerCase() !== msg.botUsername.toLowerCase()) {
      return;
    }
    // Any command escapes a pending question (forms/reminders) — start clean.
    if (state?.awaiting) {
      await patchState(store, bot.id, msg.chatId, { awaiting: null, resume: null });
    }

    // Deep-link payloads: "/start ref_xyz" — routed to payload behaviors,
    // remembered on the user's state (attribution / bind-a-chat flows).
    if (command === '/start') {
      const payload = rest;
      if (payload) {
        await patchState(store, bot.id, msg.chatId, { startPayload: payload.slice(0, 64), touch: true });
        await store.createLog(
          bot.id,
          'info',
          `Deep-link start payload received (chat ${msg.chatId}): ${payload.slice(0, 64)}`,
          'DEEPLINK_START',
        );
        // Invite credit: "ref_<chatId>" payloads count the inviter's
        // referrals (the ref_ convention every invite bot speaks). The
        // joiner remembers the inviter; the inviter's counter increments.
        const refMatch = /^ref_(\d{3,20})$/.exec(payload);
        if (refMatch && refMatch[1] !== String(msg.chatId)) {
          const inviter = await store.getUserState(bot.id, refMatch[1]).catch(() => null);
          if (inviter) {
            const current = Number(inviter.attributes['invites'] ?? 0);
            const next = (Number.isFinite(current) ? current : 0) + 1;
            await patchState(store, bot.id, refMatch[1], { attributes: { invites: String(next) }, touch: true });
            await patchState(store, bot.id, msg.chatId, { attributes: { invited_by: refMatch[1] }, touch: true });
            await store.createLog(
              bot.id,
              'info',
              `Invite credited: chat ${msg.chatId} arrived via ref_${refMatch[1]} (inviter now at ${next}).`,
              'INVITE_CREDITED',
            );
          }
        }
        const payloadRule = replyForPayload(bot, payload);
        if (payloadRule) {
          await patchState(store, bot.id, msg.chatId, { touch: true });
          await executeReplyMessages(bot, sender, payloadRule.messages, payloadRule.id, 0, ctx, state, store, deps.signal, deps.providerSelector);
          return;
        }
      }
      // A behavior (or advanced rule) bound to /start replaces the built-in
      // welcome — this is what makes "when someone starts the bot …" real.
      const welcomeRule = replyWithCommandTrigger(bot, '/start');
      if (welcomeRule) {
        await executeReplyMessages(bot, sender, welcomeRule.messages, welcomeRule.id, 0, ctx, state, store, deps.signal, deps.providerSelector, payload || '/start');
        return;
      }
      await sendSafely(bot.id, sender, msg.chatId, START_TEXT(bot.name), store, deps.signal);
      return;
    }

    // Custom menu command (static): the owner's text wins over built-ins.
    const custom = caps(bot).commands.find((c) => c.command.toLowerCase() === command);
    if (custom && custom.kind === 'static' && custom.response.trim()) {
      await executeReplyMessages(
        bot,
        sender,
        [{ text: custom.response }],
        `cmd_${command.slice(1)}`,
        0,
        ctx,
        state,
        store,
        deps.signal,
        deps.providerSelector,
        trimmed,
      );
      return;
    }

    // Custom AI command: the turn goes to the model with the command's
    // response as extra guidance ("AI answers" in the behavior editor).
    if (custom && custom.kind === 'ai') {
      const userText = rest || command;
      await runAiTurn(bot, sender, ctx, state, userText, custom.response.trim() || undefined, store, deps.signal, deps.providerSelector);
      return;
    }

    // Reply rule bound to this command (buttons/workflows on /commands).
    const rule = replyWithCommandTrigger(bot, command);
    if (rule) {
      await executeReplyMessages(bot, sender, rule.messages, rule.id, 0, ctx, state, store, deps.signal, deps.providerSelector, trimmed);
      return;
    }

    if (command === '/help') {
      await sendSafely(bot.id, sender, msg.chatId, helpText(caps(bot).commands), store, deps.signal);
      return;
    }

    // Unknown command → owner's fallback reply or the classic hint.
    const fb = fallbackReply(bot);
    if (fb) {
      await executeReplyMessages(bot, sender, fb.messages, fb.id, 0, ctx, state, store, deps.signal, deps.providerSelector, trimmed);
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

  // --- Pending answers (collect / reminder parsing) ------------------------
  // The bot asked a question; this text is the answer. Commands above are the
  // escape hatch, everything else is captured.
  if (state?.awaiting) {
    await handleAwaitingAnswer(bot, sender, ctx, state, trimmed, store, deps.signal, deps.providerSelector);
    return;
  }

  // --- Exact-text replies (reply keyboards) --------------------------------
  const exact = replyForExactText(bot, trimmed);
  if (exact) {
    await executeReplyMessages(bot, sender, exact.messages, exact.id, 0, ctx, state, store, deps.signal, deps.providerSelector, trimmed);
    return;
  }

  // --- Groups: free text only reaches the bot when it is addressed ---------
  // Privacy mode already filters group traffic; when privacy is OFF the bot
  // would otherwise reply to every human message — the mention is the gate.
  if (isGroup && !msg.mentionsBot) return;

  // --- Keyword-triggered replies -------------------------------------------
  const keywordReply = replyForKeyword(bot, trimmed);
  if (keywordReply) {
    await executeReplyMessages(bot, sender, keywordReply.messages, keywordReply.id, 0, ctx, state, store, deps.signal, deps.providerSelector, trimmed);
    return;
  }

  // --- Fallback reply for free text (when configured) ----------------------
  const fb = fallbackReply(bot);
  if (fb) {
    await executeReplyMessages(bot, sender, fb.messages, fb.id, 0, ctx, state, store, deps.signal, deps.providerSelector, trimmed);
    return;
  }

  // --- AI pipeline ----------------------------------------------------------
  // 1. Persist user turn, 2. build context window, 3. call provider,
  // 4. persist assistant turn, 5. trim memory, 6. deliver reply.
  const noteForAI = msg.hasPhoto
    ? `${trimmed}\n\n(The user sent this together with a photo. NURAE reads the caption text only.)`
    : trimmed;
  await runAiTurn(bot, sender, ctx, state, noteForAI, undefined, store, deps.signal, deps.providerSelector);
}

/**
 * Pay-as-you-use gate for platform-key AI calls: customer bots answering on
 * NURAE's AI key cost the owner one `ai_reply` unit; BYOK bots are free
 * (they pay their own provider). Returns false when the charge was skipped
 * (out of credits — the reply is NOT generated, the skip is logged).
 * Billing outages fail open.
 */
async function meterPlatformAiCall(bot: RuntimeBotRecord, store: RuntimeStore, feature: 'ai_reply'): Promise<boolean> {
  if (!bot.ownerId || bot.apiKey) return true;
  try {
    const result = await chargeFeature(bot.ownerId, feature, { refId: bot.id });
    if (result.outcome === 'skipped') {
      await store.createLog(
        bot.id,
        'warn',
        `AI reply NOT generated — owner out of credits (needs ${formatUsd(result.chargedMicros)}). Top up in Billing.`,
        'BILLING_SKIP',
      );
      return false;
    }
    return true;
  } catch {
    return true; // billing outage — never take a conversation down
  }
}

/**
 * One full AI turn — typing indicator, memory, per-user context, provider
 * call, delivery, friendly failure. Shared by the free-text path, "AI
 * answers" commands and compiled "Ask the AI" behavior steps.
 */
async function runAiTurn(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  ctx: TurnContext,
  state: BotUserStateData | null,
  userText: string,
  extraInstruction: string | undefined,
  store: RuntimeStore,
  signal?: AbortSignal | null,
  providerSelector?: PipelineDeps['providerSelector'],
): Promise<void> {
  // Typing indicator while the model thinks (cosmetic — never fails).
  if (sender.sendChatAction) {
    await sender.sendChatAction(ctx.chatId, 'typing', { signal: signal ?? undefined });
  }
  await store.appendUserMessage(bot.id, ctx.chatId, userText);
  const history = await store.getRecentMessages(bot.id, ctx.chatId, bot.memorySize);
  const userBlock = userContextBlock(state);
  const system = extraInstruction
    ? `${bot.systemPrompt}${userBlock}\n\n${extraInstruction}`
    : `${bot.systemPrompt}${userBlock}`;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];

  let reply: string;
  try {
    const selector = providerSelector ?? selectProvider;
    const selection = selector(bot.provider, {
      apiKey: bot.apiKey,
      baseUrl: bot.baseUrl,
    });
    if (selection.info.requiresKey && !selection.apiKey) {
      throw new AIError('missing_credentials', `No API key configured for provider "${selection.info.id}".`);
    }
    if (!(await meterPlatformAiCall(bot, store, 'ai_reply'))) return;
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
      signal: signal ?? undefined,
    });
    await store.createLog(bot.id, 'info', `AI response received (${reply.length} chars).`, 'AI_RESPONSE');
  } catch (err) {
    const aiErr = err instanceof AIError ? err : null;
    const message = aiErr ? `${aiErr.code}: ${aiErr.message}` : err instanceof Error ? err.message : String(err);
    await store.createLog(bot.id, 'error', `AI request failed — ${message}`, 'AI_REQUEST_FAILED');
    const friendly = AI_FAILURE_TEXT[aiErr?.code ?? 'api_error'] ?? AI_FAILURE_TEXT.api_error;
    await sendSafely(bot.id, sender, ctx.chatId, `⚠️ ${friendly}`, store, signal);
    return;
  }

  await store.appendAssistantMessage(bot.id, ctx.chatId, reply);
  if (bot.memorySize > 0) {
    await store.trimConversation(bot.id, ctx.chatId, bot.memorySize);
  }
  await sendMarkdownReply(bot, sender, ctx, [{ text: reply }], store, signal);
}

// ---------------------------------------------------------------------------
// Pending answers: collect (forms) + schedule (reminders)
// ---------------------------------------------------------------------------

/** Execute the rest of a paused flow after the user's answer was stored. */
async function handleAwaitingAnswer(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  ctx: TurnContext,
  state: BotUserStateData,
  answer: string,
  store: RuntimeStore,
  signal?: AbortSignal | null,
  providerSelector?: PipelineDeps['providerSelector'],
): Promise<void> {
  const awaiting = state.awaiting!;

  // Reminder parsing: the bot's own AI turns "tomorrow at 9" into a schedule.
  if (awaiting === '_schedule') {
    await patchState(store, bot.id, ctx.chatId, { awaiting: null });
    await parseAndSchedule(bot, sender, ctx, state, answer, store, signal, providerSelector);
    return;
  }

  // Ordinary collect step: store the answer, then continue the paused flow.
  await patchState(store, bot.id, ctx.chatId, {
    attributes: { [awaiting]: answer },
    awaiting: null,
    resume: null,
    touch: true,
  });
  await store.createLog(
    bot.id,
    'info',
    `Answer stored for "${awaiting}" (chat ${ctx.chatId}).`,
    'COLLECT_ANSWERED',
  );

  const ruleId = state.resumeRuleId;
  const resumeStep = state.resumeStep ?? 0;
  const rule = ruleId ? caps(bot).replies.find((r) => r.id === ruleId) : undefined;
  if (!rule || resumeStep + 1 >= rule.messages.length) return; // flow ended — nothing more to send
  await executeReplyMessages(
    bot,
    sender,
    rule.messages,
    rule.id,
    resumeStep + 1,
    ctx,
    { ...state, attributes: { ...state.attributes, [awaiting]: answer }, awaiting: null, resumeRuleId: null, resumeStep: null },
    store,
    signal,
    providerSelector,
  );
}

/**
 * Reminder request → the bot's AI parses a strict JSON {iso, text} →
 * BotSchedule row. Failures answer honestly and let the user retry.
 */
async function parseAndSchedule(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  ctx: TurnContext,
  state: BotUserStateData | null,
  request: string,
  store: RuntimeStore,
  signal?: AbortSignal | null,
  providerSelector?: PipelineDeps['providerSelector'],
): Promise<void> {
  const instruction =
    'You convert reminder requests into STRICT JSON. Reply with ONLY a JSON object, no prose, no code fences: ' +
    '{"iso": "<an ISO 8601 datetime in UTC>", "text": "<short reminder text, max 200 chars>"}. ' +
    'Assume UTC unless the user names a timezone. The request is: "' +
    request.slice(0, 500) + '"';

  let raw: string;
  try {
    const selector = providerSelector ?? selectProvider;
    const selection = selector(bot.provider, { apiKey: bot.apiKey, baseUrl: bot.baseUrl });
    if (selection.info.requiresKey && !selection.apiKey) {
      throw new AIError('missing_credentials', 'No API key configured.');
    }
    if (!(await meterPlatformAiCall(bot, store, 'ai_reply'))) return;
    raw = await selection.provider.generate(
      [
        { role: 'system', content: bot.systemPrompt },
        { role: 'user', content: instruction },
      ],
      {
        model: bot.model,
        temperature: 0,
        maxTokens: Math.min(bot.maxTokens, 300),
        apiKey: selection.apiKey,
        baseUrl: selection.baseUrl,
        signal: signal ?? undefined,
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await store.createLog(bot.id, 'warn', `Reminder parse failed — ${detail}`, 'SCHEDULE_PARSE_FAILED');
    await sendSafely(
      bot.id,
      sender,
      ctx.chatId,
      "I couldn't set that reminder (the time parser is unavailable right now). Please try again in a moment.",
      store,
      signal,
    );
    return;
  }

  const parsed = parseReminderJson(raw);
  if (!parsed) {
    // Keep waiting — the user can retry the time, the flow stays parked.
    await patchState(store, bot.id, ctx.chatId, { awaiting: '_schedule' });
    await sendSafely(
      bot.id,
      sender,
      ctx.chatId,
      "I couldn't work out a time from that — try a phrase like “tomorrow at 9am” or “in 2 hours”, and I'll set the reminder.",
      store,
      signal,
    );
    return;
  }
  const runAt = parsed.date;
  if (runAt.getTime() <= Date.now() - 60_000 || runAt.getTime() > Date.now() + 1000 * 60 * 60 * 24 * 365) {
    await patchState(store, bot.id, ctx.chatId, { awaiting: '_schedule' });
    await sendSafely(
      bot.id,
      sender,
      ctx.chatId,
      'That time is in the past (or over a year away) — give me a future time and I will set the reminder.',
      store,
      signal,
    );
    return;
  }
  await store.createSchedule({
    botId: bot.id,
    chatId: ctx.chatId,
    text: parsed.text,
    runAt,
    recurrence: 'once',
    createdBy: 'bot',
  });
  await store.createLog(
    bot.id,
    'info',
    `Reminder scheduled for chat ${ctx.chatId} at ${runAt.toISOString()}: ${parsed.text.slice(0, 80)}`,
    'SCHEDULE_CREATED',
  );
  await sendMarkdownReply(
    bot,
    sender,
    ctx,
    [{ text: `⏰ Done — I'll remind you on ${formatUtc(runAt)} (UTC):\n\n${parsed.text}` }],
    store,
    signal,
  );
}

function parseReminderJson(raw: string): { date: Date; text: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { iso?: unknown; text?: unknown };
    if (typeof obj.iso !== 'string' || typeof obj.text !== 'string') return null;
    const date = new Date(obj.iso);
    if (Number.isNaN(date.getTime())) return null;
    return { date, text: obj.text.slice(0, 400) || 'Reminder' };
  } catch {
    return null;
  }
}

function formatUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Payments (Telegram Stars)
// ---------------------------------------------------------------------------

/** pre_checkout_query must be answered within 10 seconds — always confirm. */
async function handlePreCheckout(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  queryId: string,
  store: RuntimeStore,
): Promise<void> {
  await store.createLog(bot.id, 'info', `Pre-checkout confirmed (query ${queryId.slice(0, 16)}…).`, 'PAYMENT_PRECHECKOUT');
  try {
    await sender.answerPreCheckoutQuery?.(queryId, true);
  } catch {
    // The answer is best-effort; Telegram proceeds on silence after timeout.
  }
}

async function handleSuccessfulPayment(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  msg: InboundMessage,
  state: BotUserStateData | null,
  store: RuntimeStore,
  signal?: AbortSignal | null,
): Promise<void> {
  const p = msg.paymentInfo!;
  const ctx: TurnContext = { chatId: msg.chatId, fromName: msg.fromName, fromFirstName: msg.fromFirstName, botUsername: bot.telegramUsername ?? undefined };
  await store.recordPayment({
    botId: bot.id,
    chatId: msg.chatId,
    chargeId: p.chargeId,
    amount: p.amount,
    currency: p.currency,
    payload: p.payload,
    title: paymentTitleFor(bot, p.payload),
  });

  // Platform topups ride on the official bot: payload nurae_topup_<orderNo>.
  // Customer bots cannot mint such payloads (their payment steps compile to
  // p_<behavior>_<step>), and the ownerId===null guard keeps it that way.
  if (bot.ownerId === null) {
    const orderNo = parseTopupPayload(p.payload);
    if (orderNo) {
      await handlePlatformTopupPayment(sender, msg.chatId, orderNo, p.chargeId, p.amount);
      return;
    }
  }

  await patchState(store, bot.id, msg.chatId, {
    attributes: { [`paid_${p.payload}`]: 'yes' },
    touch: true,
  });
  await store.createLog(
    bot.id,
    'info',
    `Stars payment received (chat ${msg.chatId}): ${p.amount} ${p.currency} payload=${p.payload.slice(0, 64)}.`,
    'PAYMENT_RECEIVED',
  );
  const successText = successTextFor(bot, p.payload);
  if (successText) {
    await executeReplyMessages(bot, sender, [{ text: successText }], `pay_${p.payload.slice(0, 32)}`, 0, ctx, state, store, signal);
  }
}

/**
 * A wallet topup paid in Stars on the official bot: mark the order paid and
 * credit the buyer's wallet. Every failure is logged, never thrown — the
 * payment DID happen; reconciliation is always possible from BotPayment rows.
 */
async function handlePlatformTopupPayment(
  sender: MessageSender,
  chatId: string,
  orderNo: string,
  chargeId: string,
  stars: number,
): Promise<void> {
  try {
    const { completeStarsTopup } = await import('../billing/topups');
    const result = await completeStarsTopup(orderNo, { chargeId, stars });
    const micros = stars * (await import('../billing/catalog')).starsRateMicros();
    const text = result.credited
      ? `✅ Payment received — ${stars}★ (${formatUsd(micros)}) added to your NURAE balance.\nThank you! Manage your usage at NURAE → Billing.`
      : `✅ Payment confirmed (${stars}★). Your balance was already credited for order ${orderNo}.`;
    await sender.sendMessage(chatId, text);
  } catch (err) {
    console.error('[billing] topup settlement failed:', err instanceof Error ? err.message : err);
  }
}

function paymentTitleFor(bot: RuntimeBotRecord, payload: string): string {
  for (const r of caps(bot).replies) {
    for (const m of r.messages) {
      if (m.payment && (m.payment.payload === payload || `p_${r.id.replace(/^b_/, '')}` === payload)) return m.payment.title;
    }
  }
  return 'Stars payment';
}

function successTextFor(bot: RuntimeBotRecord, payload: string): string | undefined {
  for (const r of caps(bot).replies) {
    for (const m of r.messages) {
      if (m.payment?.payload === payload && m.payment.successText) return m.payment.successText;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Inline mode + membership + polls
// ---------------------------------------------------------------------------

/** Inline answers come from the bot's static menu content (fast, no AI). */
export async function handleInlineQuery(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  queryId: string,
  store: RuntimeStore,
): Promise<void> {
  const results: InlineQueryResult[] = caps(bot).commands
    .filter((c) => c.kind === 'static' && c.response.trim())
    .slice(0, 20)
    .map((c) => ({
      id: c.command.replace(/^\//, '').slice(0, 40) || 'r',
      title: c.description.slice(0, 128) || c.command,
      body: telegramHtmlFromMarkdown(c.response),
      description: c.response.replace(/\s+/g, ' ').slice(0, 128),
    }));
  if (!results.length) {
    await store.createLog(bot.id, 'info', 'Inline query received but no static content to share.', 'INLINE_QUERY_EMPTY');
    return;
  }
  try {
    await sender.answerInlineQuery?.(queryId, results, { cacheTime: 30, isPersonal: true });
    await store.createLog(bot.id, 'info', `Inline query answered with ${results.length} result(s).`, 'INLINE_QUERY_ANSWERED');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await store.createLog(bot.id, 'warn', `Inline answer failed: ${detail}`, 'INLINE_QUERY_FAILED');
  }
}

async function handleMyChatMember(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  update: TelegramUpdateLike,
  store: RuntimeStore,
): Promise<void> {
  const mcm = update.my_chat_member!;
  const status = mcm.new_chat_member?.status ?? 'unknown';
  const chatId = String(mcm.chat?.id ?? 0);
  if (status === 'kicked') {
    await store.createLog(bot.id, 'info', `The bot was blocked by chat ${chatId}.`, 'BOT_BLOCKED');
  } else if (status === 'member' || status === 'administrator') {
    await store.createLog(bot.id, 'info', `The bot was added to chat ${chatId} as ${status}.`, 'BOT_ADDED');
  } else {
    await store.createLog(bot.id, 'info', `Bot status in chat ${chatId}: ${status}.`, 'BOT_STATUS_CHANGED');
  }
  void sender;
}

async function handlePollAnswer(
  bot: RuntimeBotRecord,
  store: RuntimeStore,
  update: TelegramUpdateLike,
): Promise<void> {
  const pa = update.poll_answer!;
  const choice = (pa.option_ids ?? []).join(',');
  const voter = String(pa.voter_chat?.id ?? pa.user?.id ?? 'unknown');
  await patchState(store, bot.id, voter, {
    attributes: { [`poll_${pa.poll_id.slice(0, 32)}`]: choice },
    touch: true,
  });
  await store.createLog(
    bot.id,
    'info',
    `Poll answer from chat ${voter} (poll ${pa.poll_id.slice(0, 16)}…): option ${choice}.`,
    'POLL_ANSWERED',
  );
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

  const state = await readState(store, bot.id, cb.chatId);
  const displayName = cb.fromFirstName || cb.fromName;
  await patchState(store, bot.id, cb.chatId, {
    touch: true,
    ...(displayName ? { attributes: { name: displayName.slice(0, 64) } } : {}),
  });

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
  const ctx: TurnContext = { chatId: cb.chatId, fromName: cb.fromName, messageId: cb.messageId, botUsername: bot.telegramUsername ?? undefined };
  await executeReplyMessages(bot, sender, rule.messages, rule.id, 0, ctx, state, store, deps.signal, deps.providerSelector, rule.name);
}

// ---------------------------------------------------------------------------
// Unified update routing (webhook + polling + future transports share this)
// ---------------------------------------------------------------------------

/** Route one raw Telegram update to the right pipeline handler. Never throws. */
export async function routeBotUpdate(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  update: TelegramUpdateLike,
  deps: PipelineDeps,
  opts?: { botUsername?: string },
): Promise<boolean> {
  const { store } = deps;
  const callback = updateToCallback(update);
  if (callback) {
    await store.createLog(
      bot.id,
      'info',
      `Button press received from chat ${callback.chatId} (data: ${callback.data.slice(0, 64)}).`,
      'TELEGRAM_CALLBACK_RECEIVED',
    );
    await handleBotCallback(bot, sender, callback, deps);
    return true;
  }

  const inline = update.inline_query;
  if (inline) {
    await handleInlineQuery(bot, sender, inline.id, store);
    return true;
  }

  const preCheckout = update.pre_checkout_query;
  if (preCheckout) {
    await handlePreCheckout(bot, sender, preCheckout.id, store);
    return true;
  }

  if (update.my_chat_member) {
    await handleMyChatMember(bot, sender, update, store);
    return true;
  }

  if (update.poll_answer) {
    await handlePollAnswer(bot, store, update);
    return true;
  }

  const msg = updateToInboundMessage(update, opts?.botUsername);
  if (!msg) return false; // nothing this pipeline handles

  await store.createLog(
    bot.id,
    'info',
    `Message received from chat ${msg.chatId} (${msg.text.length} chars${msg.hasPhoto ? ', photo' : ''}${msg.service ? `, ${msg.service}` : ''}).`,
    'TELEGRAM_MESSAGE_RECEIVED',
  );
  await handleBotMessage(bot, sender, msg, deps);
  return true;
}

// ---------------------------------------------------------------------------
// Update mapping
// ---------------------------------------------------------------------------

/** Map a raw Telegram update into a pipeline message (transport helper). */
export function updateToInboundMessage(update: TelegramUpdateLike, botUsername?: string): InboundMessage | null {
  const message = update.message;
  if (!message) return null;
  const base = {
    chatId: String(message.chat.id),
    fromBot: message.from?.is_bot ?? false,
    fromName: message.from?.username,
    fromFirstName: message.from?.first_name,
    chatType: message.chat.type,
    botUsername,
  };
  const mentions = (text: string) =>
    Boolean(botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`));

  // Group joins: new_chat_members service messages (the welcome trigger).
  if (message.new_chat_members?.length) {
    const humans = message.new_chat_members.filter((m) => !m.is_bot);
    if (!humans.length) return null;
    return {
      ...base,
      text: '',
      service: 'member_joined',
      joinedNames: humans.map((m) => m.first_name ?? m.username ?? 'someone'),
    };
  }

  // Stars payments arrive as successful_payment service messages.
  if (message.successful_payment) {
    const sp = message.successful_payment;
    return {
      ...base,
      text: '',
      service: 'payment',
      paymentInfo: {
        chargeId: sp.telegram_payment_charge_id,
        amount: sp.total_amount,
        currency: sp.currency,
        payload: sp.invoice_payload,
      },
    };
  }

  // Media: photo messages carry the caption; text-only otherwise. NURAE does
  // not run vision models — captions are read, pixels are not (documented).
  if (typeof message.text === 'string') {
    return {
      ...base,
      text: message.text,
      hasPhoto: false,
      mentionsBot: message.chat.type !== 'private' ? mentions(message.text) : false,
    };
  }
  if (message.photo?.length && typeof message.caption === 'string') {
    return {
      ...base,
      text: message.caption,
      hasPhoto: true,
      mentionsBot: message.chat.type !== 'private' ? mentions(message.caption) : false,
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
    fromFirstName: cq.from?.first_name,
    messageId: cq.message?.message_id,
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
    new_chat_members?: Array<{ id: number; is_bot: boolean; first_name?: string; username?: string }>;
    successful_payment?: {
      currency: string;
      total_amount: number;
      invoice_payload: string;
      telegram_payment_charge_id: string;
    };
    reply_to_message?: { message_id: number; from?: { id: number; is_bot: boolean } };
  };
  callback_query?: {
    id: string;
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    message?: { message_id?: number; chat?: { id: number; type?: string } };
    data?: string;
  };
  inline_query?: {
    id: string;
    from?: { id: number; is_bot: boolean; username?: string };
    query?: string;
  };
  pre_checkout_query?: {
    id: string;
    from?: { id: number; is_bot: boolean; username?: string };
    currency?: string;
    total_amount?: number;
    invoice_payload?: string;
  };
  my_chat_member?: {
    chat?: { id: number; type?: string; title?: string };
    from?: { id: number; is_bot: boolean; username?: string };
    old_chat_member?: { status?: string };
    new_chat_member?: { status?: string; user?: { id: number; is_bot: boolean } };
  };
  poll_answer?: {
    poll_id: string;
    user?: { id: number; is_bot: boolean; username?: string };
    voter_chat?: { id: number };
    option_ids?: number[];
  };
}

// ---------------------------------------------------------------------------
// Reply execution — the full outbound surface, in order
// ---------------------------------------------------------------------------

interface ReplyMessage {
  text: string;
  buttons?: OutboundButtons;
  ai?: string;
  media?: { kind: OutboundMedia['kind']; source: string; caption?: string; filename?: string };
  poll?: OutboundPoll;
  location?: { latitude: number; longitude: number; title?: string; address?: string };
  payment?: { title: string; description: string; priceStars: number; payload?: string; successText?: string };
  collect?: { attribute: string; prompt?: string };
  schedule?: { prompt?: string };
  remember?: { attribute: string; value: string; mode: 'set' | 'add' };
  draw?: { attribute: string; announce: string; emptyText: string };
  top?: { attribute: string; title: string; limit: number };
  edit?: boolean;
  keyboard?: 'reply' | 'inline' | 'none';
  forceReply?: boolean;
  removeKeyboard?: boolean;
}

interface TurnContext {
  chatId: string;
  fromName?: string;
  fromFirstName?: string;
  /** The message a button was pressed on — enables edit-in-place. */
  messageId?: number;
  /** The bot's own @username ("{{bot_username}}", invite links). */
  botUsername?: string;
}

/**
 * Buttons with per-user content: copy texts and link URLs support
 * {{placeholders}} (invite links, share links). A URL that templates into
 * something non-HTTP is dropped rather than sent — Telegram would refuse
 * the whole message otherwise. Rows that end up empty disappear too.
 */
function templateButtons(
  buttons: OutboundButtons | undefined,
  state: BotUserStateData,
  ctx: TurnContext,
): OutboundButtons | undefined {
  if (!buttons?.length) return buttons;
  let changed = false;
  const rows: OutboundButtons = [];
  for (const row of buttons) {
    const outRow: Array<{ text: string; url?: string; callback?: string; webapp?: string; copy?: string }> = [];
    for (const b of row) {
      let btn = b;
      if (btn.copy) {
        const copy = applyTemplate(btn.copy, state, ctx);
        if (copy !== btn.copy) {
          btn = { ...btn, copy };
          changed = true;
        }
      }
      if (btn.url) {
        const url = applyTemplate(btn.url, state, ctx);
        if (url !== btn.url) {
          changed = true;
          if (!/^https?:\/\//i.test(url)) continue; // templated into garbage — drop, never send
          btn = { ...btn, url };
        }
      }
      outRow.push(btn);
    }
    if (outRow.length) rows.push(outRow);
  }
  return changed ? (rows.length ? rows : undefined) : buttons;
}

/**
 * Deliver reply messages from index `start` (a mini workflow when >1):
 * text (templated, markdown → Telegram HTML, ≤4096 chunks, plain retry),
 * media, polls, Stars invoices, collect/schedule pauses, edit-in-place,
 * reply keyboards, force replies — exactly what Telegram will deliver.
 */
async function executeReplyMessages(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  replyMessages: ReplyMessage[],
  ruleId: string,
  start: number,
  ctx: TurnContext,
  state: BotUserStateData | null,
  store: RuntimeStore,
  signal?: AbortSignal | null,
  providerSelector?: PipelineDeps['providerSelector'],
  triggerText?: string,
): Promise<void> {
  // A mutable view of the user's state: remember steps write through so
  // later steps in the same flow template fresh values ("Your score: 3").
  const st: BotUserStateData = state ?? {
    botId: bot.id,
    chatId: ctx.chatId,
    attributes: {},
    awaiting: null,
    resumeRuleId: null,
    resumeStep: null,
    startPayload: null,
  };
  for (const [index, message] of replyMessages.entries()) {
    if (index < start) continue;

    if (message.ai !== undefined) {
      await runAiTurn(bot, sender, ctx, state, triggerText ?? message.text, message.ai || undefined, store, signal, providerSelector);
      continue;
    }

    if (message.payment) {
      if (!sender.sendInvoice) {
        await store.createLog(bot.id, 'warn', 'Invoice requested but the sender cannot send payments — skipped.', 'PAYMENT_SKIPPED');
        continue;
      }
      try {
        await sender.sendInvoice(ctx.chatId, {
          title: message.payment.title,
          description: message.payment.description,
          priceStars: message.payment.priceStars,
          payload: message.payment.payload || `p_${ruleId.slice(0, 32)}`,
        }, { signal: signal ?? undefined });
        await store.createLog(
          bot.id,
          'info',
          `Stars invoice sent (chat ${ctx.chatId}): ${message.payment.priceStars}★ — ${message.payment.title}.`,
          'PAYMENT_INVOICE_SENT',
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await store.createLog(bot.id, 'warn', `Invoice send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
      }
      continue;
    }

    if (message.media && sender.sendMedia) {
      const caption = applyTemplate(message.media.caption ?? '', st, ctx);
      const buttons = templateButtons(message.buttons, st, ctx);
      try {
        await sender.sendMedia(
          ctx.chatId,
          {
            kind: message.media.kind,
            source: message.media.source,
            caption: caption || undefined,
            filename: message.media.filename,
          },
          {
            signal: signal ?? undefined,
            parseMode: caption ? 'HTML' : undefined,
            buttons,
            keyboard: message.keyboard,
          },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await store.createLog(bot.id, 'warn', `Media send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
      }
      continue;
    }

    if (message.poll && sender.sendPoll) {
      try {
        await sender.sendPoll(ctx.chatId, message.poll, { signal: signal ?? undefined });
        await store.createLog(bot.id, 'info', `Poll sent (chat ${ctx.chatId}): ${message.poll.question.slice(0, 60)}`, 'POLL_SENT');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await store.createLog(bot.id, 'warn', `Poll send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
      }
      continue;
    }

    // Ask-and-remember: send the prompt, park the flow, wait for the answer.
    if (message.collect) {
      const prompt = message.collect.prompt || message.text || 'Please type your answer.';
      await patchState(store, bot.id, ctx.chatId, {
        awaiting: message.collect.attribute,
        resume: { ruleId, step: index },
        touch: true,
      });
      await sendMarkdownReply(bot, sender, ctx, [{ text: prompt }], store, signal);
      return; // the flow pauses here — the answer resumes it
    }

    // Set-a-reminder: same pause mechanics, the answer is time-parsed.
    if (message.schedule) {
      const prompt = message.schedule.prompt || message.text || 'When should I remind you? e.g. “tomorrow at 9am”.';
      await patchState(store, bot.id, ctx.chatId, {
        awaiting: '_schedule',
        resume: { ruleId, step: index },
        touch: true,
      });
      await sendMarkdownReply(bot, sender, ctx, [{ text: prompt }], store, signal);
      return;
    }

    // Remember: a silent attribute write — counters, flags, entries. 'add'
    // mode numerically increments (missing counts as 0, non-numeric as 0).
    if (message.remember) {
      let value = message.remember.value;
      if (message.remember.mode === 'add') {
        const current = Number(st.attributes[message.remember.attribute] ?? 0);
        const add = Number(value === '' ? '1' : value);
        value = String((Number.isFinite(current) ? current : 0) + (Number.isFinite(add) ? add : 0));
      }
      st.attributes[message.remember.attribute] = value;
      await patchState(store, bot.id, ctx.chatId, {
        attributes: { [message.remember.attribute]: value },
        touch: true,
      });
      continue;
    }

    // Draw: pick a random user holding the attribute and announce it.
    if (message.draw) {
      const entrants = await store.listUsersWithAttribute(bot.id, message.draw.attribute).catch(() => []);
      if (!entrants.length) {
        await sendMarkdownReply(bot, sender, ctx, [{ text: message.draw.emptyText }], store, signal);
        await store.createLog(bot.id, 'info', `Draw over "${message.draw.attribute}" had no entrants — nothing drawn.`, 'DRAW_EMPTY');
      } else {
        const winner = entrants[Math.floor(Math.random() * entrants.length)];
        const text = message.draw.announce
          .replace(/\{\{\s*winner_name\s*\}\}/g, winner.name ?? `user ${winner.chatId}`)
          .replace(/\{\{\s*winner_chat\s*\}\}/g, winner.chatId)
          .replace(/\{\{\s*count\s*\}\}/g, String(entrants.length));
        await sendMarkdownReply(bot, sender, ctx, [{ text }], store, signal);
        await store.createLog(
          bot.id,
          'info',
          `Draw over "${message.draw.attribute}": winner chat ${winner.chatId} among ${entrants.length} entrant(s).`,
          'DRAW_EXECUTED',
        );
      }
      continue;
    }

    // Leaderboard: rank users by a numeric attribute, post the top slice.
    if (message.top) {
      const users = await store.listUsersWithAttribute(bot.id, message.top.attribute).catch(() => []);
      const ranked = users
        .map((u) => ({ ...u, n: Number(u.value) }))
        .filter((u) => Number.isFinite(u.n))
        .sort((a, b) => b.n - a.n)
        .slice(0, message.top.limit);
      const text = ranked.length
        ? `${message.top.title}\n\n${ranked.map((u, i) => `${i + 1}. ${u.name ?? `user ${u.chatId}`} — ${u.n}`).join('\n')}`
        : `${message.top.title}\n\nNo entries yet.`;
      await sendMarkdownReply(bot, sender, ctx, [{ text }], store, signal);
      await store.createLog(bot.id, 'info', `Leaderboard "${message.top.attribute}" posted (${ranked.length} row(s)).`, 'TOP_POSTED');
      continue;
    }

    // Plain text (the default): template → HTML → chunks → edit or send.
    const chunks = chunkTelegramMessage(message.text || ' ');
    for (const [ci, chunk] of chunks.entries()) {
      const templated = applyTemplate(chunk, st, ctx);
      const html = telegramHtmlFromMarkdown(templated);
      const buttons: OutboundButtons | undefined =
        ci === 0 && (index === 0 || message.edit) ? templateButtons(message.buttons, st, ctx) : undefined;
      const sendOpts: SendOptions = {
        signal: signal ?? undefined,
        parseMode: 'HTML',
        buttons,
        keyboard: message.keyboard,
        forceReply: message.forceReply,
        removeKeyboard: message.removeKeyboard,
      };
      try {
        if (message.edit && ctx.messageId && sender.editMessageText) {
          await sender.editMessageText(ctx.chatId, ctx.messageId, html, sendOpts);
          continue;
        }
        await sender.sendMessage(ctx.chatId, html, sendOpts);
      } catch (err) {
        if (err instanceof TelegramApiError && err.status === 400) {
          // Telegram refused the entity markup (should not happen — the
          // converter only emits balanced escaped HTML) — degrade to plain.
          await store.createLog(
            bot.id,
            'warn',
            `Telegram rejected HTML entities for chat ${ctx.chatId}; resending as plain text.`,
            'TELEGRAM_HTML_FALLBACK',
          );
          try {
            if (message.edit && ctx.messageId && sender.editMessageText) {
              await sender.editMessageText(ctx.chatId, ctx.messageId, templated, { ...sendOpts, parseMode: undefined });
            } else {
              await sender.sendMessage(ctx.chatId, templated, { ...sendOpts, parseMode: undefined });
            }
          } catch (fallbackErr) {
            const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            await store.createLog(bot.id, 'warn', `Telegram send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
          }
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          await store.createLog(bot.id, 'warn', `Telegram send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
        }
      }
    }
  }
  await store.createLog(
    bot.id,
    'info',
    `Reply delivered to chat ${ctx.chatId} (${replyMessages.length} message(s)).`,
    'TELEGRAM_MESSAGE_SENT',
  );
}

/** Markdown-pipeline wrapper kept for built-in texts (START/help/AI turns). */
async function sendMarkdownReply(
  bot: RuntimeBotRecord,
  sender: MessageSender,
  ctx: TurnContext,
  replyMessages: ReplyMessage[],
  store: RuntimeStore,
  signal?: AbortSignal | null,
): Promise<void> {
  for (const [index, message] of replyMessages.entries()) {
    const chunks = chunkTelegramMessage(message.text || ' ');
    for (const [, chunk] of chunks.entries()) {
      const html = telegramHtmlFromMarkdown(chunk);
      const buttons: OutboundButtons | undefined = index === 0 ? message.buttons : undefined;
      try {
        await sender.sendMessage(ctx.chatId, html, {
          signal: signal ?? undefined,
          parseMode: 'HTML',
          buttons,
        });
      } catch (err) {
        if (err instanceof TelegramApiError && err.status === 400) {
          try {
            await sender.sendMessage(ctx.chatId, chunk, { signal: signal ?? undefined, buttons });
          } catch (fallbackErr) {
            const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            await store.createLog(bot.id, 'warn', `Telegram send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
          }
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          await store.createLog(bot.id, 'warn', `Telegram send failed for chat ${ctx.chatId}: ${detail}`, 'TELEGRAM_SEND_FAILED');
        }
      }
    }
  }
  await store.createLog(
    bot.id,
    'info',
    `Reply delivered to chat ${ctx.chatId} (${replyMessages.length} message(s)).`,
    'TELEGRAM_MESSAGE_SENT',
  );
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
