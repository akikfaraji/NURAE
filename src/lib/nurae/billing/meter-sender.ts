/**
 * NURAE — metered sender: a MessageSender wrapper that charges the bot owner
 * one unit per real outbound Telegram message (text, media, poll, invoice,
 * edit) BEFORE the send happens.
 *
 * Semantics:
 *   - charged / trial / premium / free_quota → the send proceeds.
 *   - skipped (out of credits) → the send is NOT made; onSkip fires once so
 *     the caller can log/notify. The end user just sees silence; the owner
 *     sees the skip in the bot logs and the Billing page.
 *   - billing INFRASTRUCTURE errors (db down, unknown shape) fail OPEN — a
 *     billing outage must never take conversations down with it.
 *
 * Non-delivery surfaces (callback answers, typing indicators, inline
 * answers, pre-checkout answers) pass through untouched — they are free.
 * Optional delivery methods are only exposed when the inner sender has them,
 * so existing capability detection keeps working unchanged.
 */

import type { MessageSender } from '../runtime/pipeline';
import type { ChatAction, InlineQueryResult, OutboundInvoice, OutboundMedia, OutboundPoll, SendOptions } from '../telegram/adapter';
import { chargeFeature, type ChargeResult } from './wallet';

export interface MeteredSenderOptions {
  ownerId: string;
  botId: string;
  /** 'bot_message' for conversations/schedules, 'broadcast_message' for fan-out. */
  feature: string;
  /** Called on the first skipped send (per sender instance). */
  onSkip?: (result: ChargeResult) => void;
}

export function meteredSender(inner: MessageSender, opts: MeteredSenderOptions): MessageSender {
  let skipNotified = false;

  async function gate(): Promise<boolean> {
    let result: ChargeResult;
    try {
      result = await chargeFeature(opts.ownerId, opts.feature, { refId: opts.botId });
    } catch {
      // Billing outage → fail open (send goes through, money reconciles later).
      return true;
    }
    if (result.outcome === 'skipped') {
      if (!skipNotified) {
        skipNotified = true;
        try {
          await opts.onSkip?.(result);
        } catch {
          /* never let the notification break the turn */
        }
      }
      return false;
    }
    return true;
  }

  const sender: MessageSender = {
    sendMessage: async (chatId, text, sendOpts) => {
      if (!(await gate())) return;
      await inner.sendMessage(chatId, text, sendOpts);
    },
  };

  if (inner.answerCallbackQuery) {
    const innerFn = inner.answerCallbackQuery.bind(inner);
    sender.answerCallbackQuery = (callbackQueryId, answerOpts) => innerFn(callbackQueryId, answerOpts);
  }
  if (inner.sendChatAction) {
    const innerFn = inner.sendChatAction.bind(inner);
    sender.sendChatAction = (chatId: number | string, action: ChatAction, actionOpts?: { signal?: AbortSignal }) =>
      innerFn(chatId, action, actionOpts);
  }
  if (inner.sendMedia) {
    const innerFn = inner.sendMedia.bind(inner);
    sender.sendMedia = async (chatId: number | string, media: OutboundMedia, sendOpts?: SendOptions) => {
      if (!(await gate())) return;
      await innerFn(chatId, media, sendOpts);
    };
  }
  if (inner.sendPoll) {
    const innerFn = inner.sendPoll.bind(inner);
    sender.sendPoll = async (chatId: number | string, poll: OutboundPoll, sendOpts?: SendOptions) => {
      if (!(await gate())) return;
      await innerFn(chatId, poll, sendOpts);
    };
  }
  if (inner.sendInvoice) {
    const innerFn = inner.sendInvoice.bind(inner);
    sender.sendInvoice = async (chatId: number | string, invoice: OutboundInvoice, sendOpts?: SendOptions) => {
      if (!(await gate())) return;
      await innerFn(chatId, invoice, sendOpts);
    };
  }
  if (inner.answerPreCheckoutQuery) {
    const innerFn = inner.answerPreCheckoutQuery.bind(inner);
    sender.answerPreCheckoutQuery = (queryId, ok, answerOpts) => innerFn(queryId, ok, answerOpts);
  }
  if (inner.answerInlineQuery) {
    const innerFn = inner.answerInlineQuery.bind(inner);
    sender.answerInlineQuery = (queryId, results, answerOpts) => innerFn(queryId, results, answerOpts);
  }
  if (inner.editMessageText) {
    const innerFn = inner.editMessageText.bind(inner);
    sender.editMessageText = async (chatId: number | string, messageId: number, text: string, sendOpts?: SendOptions) => {
      if (!(await gate())) return;
      await innerFn(chatId, messageId, text, sendOpts);
    };
  }

  return sender;
}
