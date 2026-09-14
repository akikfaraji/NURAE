/**
 * NURAE — bot task engine: the scheduler + broadcast fan-out.
 *
 * Two kinds of deferred work, both executed here (never inline in a webhook
 * turn — heavy sends must not block an update response):
 *
 *   1. SCHEDULES  — BotSchedule rows whose runAt passed. Text is delivered to
 *      its chat; recurring rows (daily/weekly) are re-armed at the same
 *      time-of-day (UTC) for the next occurrence.
 *   2. BROADCASTS — BotBroadcast rows created by the owner. Each fan-out is
 *      claimed atomically (pending → running) so two workers can never
 *      double-send, and paced at ~20 msg/s — safely under Telegram's ~30
 *      msg/s global broadcast ceiling. Per-chat failures (blocked bots,
 *      429s) count, never crash the run.
 *
 * Driving the engine:
 *   - a 60 s in-process ticker (startTaskTicker, Node runtimes only) started
 *     from instrumentation and after each bot start;
 *   - a fire-and-forget sweep after every webhook update (cheap: one indexed
 *     query) — serverless deployments get their work done this way too.
 */

import { TelegramAdapter } from '../telegram/adapter';
import { telegramHtmlFromMarkdown } from '../telegram/markdown';
import type { RuntimeStore } from './store';
import { chargeFeature } from '../billing/wallet';
import { runDailyHostingBilling } from '../billing/hosting';
import { pollCryptoTopups } from '../billing/topups';

const TICK_MS = 60_000;
/** Broadcast pacing: 50 ms between sends ≈ 20 msg/s (< Telegram's ~30/s). */
const BROADCAST_GAP_MS = 50;
/** Hard per-run cap so a stuck run cannot loop forever. */
const BROADCAST_MAX_SENDS_PER_RUN = 2000;

const globalForTicker = globalThis as unknown as { nuraeTaskTicker: NodeJS.Timeout | undefined };

export interface TaskRunResult {
  schedulesSent: number;
  schedulesFailed: number;
  broadcastSent: number;
  broadcastFailed: number;
}

/** Run all due schedules and claimable broadcasts (optionally for one bot). */
export async function runDueBotWork(store: RuntimeStore, opts?: { botId?: string; now?: Date }): Promise<TaskRunResult> {
  const result: TaskRunResult = { schedulesSent: 0, schedulesFailed: 0, broadcastSent: 0, broadcastFailed: 0 };
  const now = opts?.now ?? new Date();

  // --- Broadcasts first (fresh announcements feel better late by seconds) ---
  try {
    const broadcast = await store.claimPendingBroadcast(opts?.botId);
    if (broadcast) {
      const outcome = await runBroadcast(store, broadcast.id, broadcast.botId, broadcast.text);
      result.broadcastSent = outcome.sent;
      result.broadcastFailed = outcome.failed;
    }
  } catch {
    // claim/run errors surface via the broadcast row itself — keep sweeping.
  }

  // --- Schedules ---
  let due;
  try {
    due = await store.dueSchedules(now, opts?.botId);
  } catch {
    return result;
  }
  for (const schedule of due) {
    const bot = await store.getBot(schedule.botId).catch(() => null);
    if (!bot || !bot.telegramToken) {
      await store.markScheduleFailed(schedule.id, 'Bot not found or has no Telegram token.');
      result.schedulesFailed += 1;
      continue;
    }
    // Prepaid: one `bot_message` unit per scheduled send. Out of credits →
    // the schedule fails honestly instead of silently skipping the send.
    if (bot.ownerId) {
      try {
        const charge = await chargeFeature(bot.ownerId, 'bot_message', { refId: bot.id });
        if (charge.outcome === 'skipped') {
          await store.markScheduleFailed(schedule.id, 'Out of credits — the message was not sent. Top up in Billing.');
          await store.createLog(bot.id, 'warn', 'Scheduled message NOT sent — owner out of credits.', 'BILLING_SKIP');
          result.schedulesFailed += 1;
          continue;
        }
      } catch {
        /* billing outage → fail open */
      }
    }
    const adapter = new TelegramAdapter({ token: bot.telegramToken });
    try {
      const html = telegramHtmlFromMarkdown(schedule.text);
      await adapter.sendMessage(schedule.chatId, html, { parseMode: 'HTML' });
      await store.createLog(schedule.botId, 'info', `Scheduled message delivered to chat ${schedule.chatId}.`, 'SCHEDULE_SENT');
      await store.markScheduleSent(schedule.id, nextRecurrence(schedule.runAt, schedule.recurrence));
      result.schedulesSent += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await store.createLog(schedule.botId, 'warn', `Scheduled send failed for chat ${schedule.chatId}: ${detail}`, 'SCHEDULE_SEND_FAILED');
      await store.markScheduleFailed(schedule.id, detail);
      result.schedulesFailed += 1;
    }
  }

  return result;
}

async function runBroadcast(store: RuntimeStore, broadcastId: string, botId: string, text: string): Promise<{ sent: number; failed: number }> {
  const bot = await store.getBot(botId).catch(() => null);
  if (!bot || !bot.telegramToken) {
    await store.updateBroadcastProgress(broadcastId, 0, 0, { failed: true, lastError: 'Bot not found or has no Telegram token.' });
    return { sent: 0, failed: 0 };
  }
  const chats = await store.listChatIds(botId);
  await store.updateBroadcastProgress(broadcastId, 0, 0, { running: true });
  await store.createLog(botId, 'info', `Broadcast started — ${chats.length} chat(s).`, 'BROADCAST_STARTED');

  const adapter = new TelegramAdapter({ token: bot.telegramToken });
  // The per-recipient charge happens explicitly below (prepaid fan-out) —
  // no meteredSender wrapper here or every message would bill twice.
  const sender = adapter;
  const html = telegramHtmlFromMarkdown(text);
  let sent = 0;
  let failed = 0;
  let outOfCredits = false;
  for (const [i, chatId] of chats.entries()) {
    if (i >= BROADCAST_MAX_SENDS_PER_RUN) break;
    // Prepaid fan-out: one unit per recipient. Out of credits → stop honestly.
    if (bot.ownerId) {
      try {
        const charge = await chargeFeature(bot.ownerId, 'broadcast_message', { refId: botId });
        if (charge.outcome === 'skipped') {
          outOfCredits = true;
          await store.createLog(botId, 'warn', `Broadcast stopped after ${sent} send(s) — owner out of credits. Top up in Billing.`, 'BILLING_SKIP');
          break;
        }
      } catch {
        /* billing outage → fail open */
      }
    }
    try {
      await sender.sendMessage(chatId, html, { parseMode: 'HTML' });
      sent += 1;
    } catch (err) {
      // 429 → wait out retry_after once, then give up on this chat.
      const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
      if (typeof retryAfter === 'number' && retryAfter > 0 && retryAfter < 15_000) {
        await sleep(retryAfter);
        try {
          await sender.sendMessage(chatId, html, { parseMode: 'HTML' });
          sent += 1;
        } catch {
          failed += 1;
        }
      } else {
        failed += 1;
      }
    }
    if (i % 25 === 24) {
      // Persist progress so the dashboard shows a live counter.
      await store.updateBroadcastProgress(broadcastId, sent, failed, { running: true });
    }
    if (i < chats.length - 1) await sleep(BROADCAST_GAP_MS);
  }
  const lastError = failed > 0
    ? `${failed} chat(s) could not be reached (blocked bot or rate limit).`
    : outOfCredits
      ? 'Stopped early — out of credits. The remaining chats were not messaged.'
      : undefined;
  await store.updateBroadcastProgress(broadcastId, sent, failed, { done: true, lastError });
  await store.createLog(botId, 'info', `Broadcast finished — sent ${sent}, failed ${failed}.`, 'BROADCAST_DONE');
  return { sent, failed };
}

/** Next occurrence for recurring schedules (same time-of-day, UTC). */
export function nextRecurrence(runAt: Date, recurrence: string): Date | null {
  if (recurrence === 'daily') {
    const next = new Date(runAt.getTime() + 24 * 60 * 60 * 1000);
    // Keep the clock anchored: if runAt drifted, re-anchor to the original
    // time-of-day so daily reminders never slide with processing delay.
    return next;
  }
  if (recurrence === 'weekly') return new Date(runAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Periodic billing work on the ticker: daily hosting charges (idempotent per
 * bot+day) and the CryptoBot invoice poller (idempotent per order). Runs on
 * the Node ticker only — the serverless webhook sweep skips it.
 */
async function runPeriodicBilling(): Promise<void> {
  await runDailyHostingBilling().catch((err) =>
    console.warn('[billing] hosting pass failed:', err instanceof Error ? err.message : err),
  );
  await pollCryptoTopups().catch((err) =>
    console.warn('[billing] crypto poll failed:', err instanceof Error ? err.message : err),
  );
}

/**
 * Start the in-process 60 s ticker (Node runtimes only; serverless relies on
 * the webhook-adjacent sweep). Idempotent per process.
 */
export function startTaskTicker(store: RuntimeStore): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (globalForTicker.nuraeTaskTicker) return;
  const timer = setInterval(() => {
    void runDueBotWork(store).catch(() => undefined);
    void runPeriodicBilling().catch(() => undefined);
  }, TICK_MS);
  // Never hold the process open just for the ticker.
  if (typeof timer.unref === 'function') timer.unref();
  globalForTicker.nuraeTaskTicker = timer;
}
