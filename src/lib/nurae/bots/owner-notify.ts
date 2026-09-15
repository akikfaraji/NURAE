/**
 * NURAE — instant owner alerts.
 *
 * The owner registers THEIR OWN Telegram chat id on a bot (bot page or the
 * agent via bot_set_owner_chat); from then on the bot pushes the events an
 * owner cares about straight into their Telegram the moment they happen:
 * completed order/intake forms and Stars payments. No more "I only saw the
 * order when I opened the site".
 *
 * Delivery is best-effort and never throws into the pipeline: a failed alert
 * is logged (OWNER_NOTIFY_FAILED) and the customer flow continues untouched.
 * Alert text is plain text — no parse mode — so arbitrary user-collected
 * values can never break entity parsing.
 */

import { db } from '@/lib/db';
import { SecretManager } from '../secrets';
import { TelegramAdapter } from '../telegram/adapter';
import { truncateForLog } from '../sanitize';
import { createPrismaRuntimeStore } from '../runtime/store';

export interface OwnerAlert {
  title: string;
  /** Plain-text lines under the title (attribute digests, amounts, …). */
  lines: string[];
}

/** Send an alert to the bot's owner chat id. Returns whether it went out. */
export async function sendOwnerAlert(botId: string, alert: OwnerAlert): Promise<{ sent: boolean; error?: string }> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, ownerChatId: true, telegramTokenRef: true, ownerId: true },
  });
  if (!bot) return { sent: false, error: 'bot not found' };
  if (!bot.ownerChatId) return { sent: false, error: 'no owner chat id set' };

  let token = '';
  if (bot.telegramTokenRef) {
    try {
      token = SecretManager.decrypt(bot.telegramTokenRef);
    } catch {
      token = '';
    }
  }
  if (!token) return { sent: false, error: 'bot has no Telegram token' };

  const body = [`🔔 ${alert.title}`, '', ...alert.lines].join('\n');
  const adapter = new TelegramAdapter(token);
  try {
    await adapter.sendMessage(bot.ownerChatId, body, { keyboard: 'none' });
    await db.log
      .create({
        data: {
          botId: bot.id,
          level: 'info',
          event: 'OWNER_NOTIFIED',
          message: `Owner alert delivered to ${bot.ownerChatId}: ${alert.title}`,
        },
      })
      .catch(() => undefined);
    return { sent: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.log
      .create({
        data: {
          botId: bot.id,
          level: 'warn',
          event: 'OWNER_NOTIFY_FAILED',
          message: truncateForLog(`Owner alert failed for chat ${bot.ownerChatId} — ${detail}`),
        },
      })
      .catch(() => undefined);
    return { sent: false, error: detail };
  }
}

/**
 * Owner alert for a COMPLETED collect flow (order / intake / booking).
 * `attributes` are the merged per-chat values collected so far — internal
 * keys (paid_*) are hidden, everything the customer answered is shown.
 */
export function ownerFlowAlert(botName: string, chatId: string, fromName: string | undefined, attributes: Record<string, string>): OwnerAlert {
  const entries = Object.entries(attributes).filter(([k]) => !k.startsWith('paid_') && !k.startsWith('_'));
  const lines = [
    `Bot: ${botName}`,
    `Customer: ${fromName ?? 'unknown'} (chat ${chatId})`,
    '',
    ...(entries.length ? entries.map(([k, v]) => `• ${k}: ${truncateForLog(v, 300)}`) : ['(no collected fields)']),
  ];
  return { title: `New order / form completed`, lines };
}

/** Owner alert for a Stars payment received by a customer bot. */
export function ownerPaymentAlert(botName: string, chatId: string, title: string, amount: number, currency: string, payload: string): OwnerAlert {
  return {
    title: `New payment received`,
    lines: [
      `Bot: ${botName}`,
      `From chat: ${chatId}`,
      `Amount: ${amount} ${currency}`,
      `Item: ${title}`,
      `Payload: ${truncateForLog(payload, 64)}`,
    ],
  };
}

/**
 * Ownership-checked TEST alert — "Send test" on the bot page. Confirms the
 * chat id is right and the bot can actually reach the owner.
 */
export async function sendOwnerTestAlert(userId: string, botId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const bot = await db.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true, name: true, ownerChatId: true } });
  if (!bot) return { ok: false, error: 'Bot not found' };
  if (!bot.ownerChatId) {
    return { ok: false, error: 'Save your chat id first, then send the test.' };
  }
  const result = await sendOwnerAlert(bot.id, {
    title: `NURAE alerts connected`,
    lines: [`Bot: ${bot.name}`, 'You will receive completed forms, orders and payments here the moment they happen.'],
  });
  if (!result.sent) {
    return { ok: false, error: 'Delivery failed — did you send /start to YOUR bot from this account once?', detail: result.error };
  }
  return { ok: true };
}

/** Re-export so API routes can reuse the store in one import. */
export { createPrismaRuntimeStore };
