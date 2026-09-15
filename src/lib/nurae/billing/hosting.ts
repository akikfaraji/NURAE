/**
 * NURAE — daily hosting billing.
 *
 * Every running user bot costs `hosting_day` per UTC day (the "server").
 * The charge is idempotent per bot+day (ledger idempotency key), so the
 * 60-second ticker can call this as often as it likes. Unpaid days write a
 * zero-amount marker row; three distinct unpaid days in a rolling window
 * stop the bot (webhook bots lose their webhook; polling bots lose their
 * status — the wallet gate already keeps them silent either way).
 *
 * During the trial week and premium entitlements this pass records free
 * rows — hosting is included in the free week, honestly.
 */

import { db } from '@/lib/db';
import { TelegramAdapter } from '../telegram/adapter';
import { dayBucket } from './catalog';
import { planHostingCover } from './plans';
import { chargeFeature, getBalance } from './wallet';

export interface HostingResult {
  bots: number;
  charged: number;
  free: number;
  unpaid: number;
  stopped: number;
}

const UNPAID_STOP_AFTER_DAYS = 3;

export async function runDailyHostingBilling(now: Date = new Date()): Promise<HostingResult> {
  const result: HostingResult = { bots: 0, charged: 0, free: 0, unpaid: 0, stopped: 0 };
  const bots = await db.bot.findMany({
    where: { ownerId: { not: null }, enabled: true, status: 'running' },
    select: { id: true, ownerId: true, transport: true, telegramTokenRef: true },
  });
  result.bots = bots.length;

  for (const bot of bots) {
    if (!bot.ownerId) continue;
    const bucket = dayBucket(now);
    let outcome: string;
    try {
      // Plan perk first: a paid plan covers the first N running bots. The
      // covered day is journaled as a free row with the SAME idempotency key
      // the charge would have used, so a plan can never double-bill a day.
      const cover = await planHostingCover(bot.ownerId, bot.id, now);
      if (cover) {
        const key = `host:${bot.id}:${bucket}`;
        const taken = await db.ledgerEntry.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
        if (!taken) {
          await db.ledgerEntry.create({
            data: {
              userId: bot.ownerId,
              kind: 'usage',
              feature: 'hosting_day',
              amountMicros: 0,
              balanceAfter: await getBalance(bot.ownerId),
              bucket,
              refId: bot.id,
              idempotencyKey: key,
              note: `plan_hosting (${cover.name})`,
            },
          });
        }
        outcome = 'free_quota';
      } else {
        const charge = await chargeFeature(bot.ownerId, 'hosting_day', {
          refId: bot.id,
          idempotencyKey: `host:${bot.id}:${bucket}`,
        });
        outcome = charge.outcome;
      }
    } catch {
      continue; // billing outage — retry next tick
    }

    if (outcome === 'skipped') {
      result.unpaid += 1;
      await recordUnpaidDay(bot.id, bot.ownerId, bucket, now);
      const unpaidDays = await countUnpaidDays(bot.id, now);
      if (unpaidDays >= UNPAID_STOP_AFTER_DAYS) {
        await stopUnpaidBot(bot);
        result.stopped += 1;
      }
    } else if (outcome === 'charged') {
      result.charged += 1;
    } else {
      result.free += 1;
    }
  }
  return result;
}

async function recordUnpaidDay(botId: string, ownerId: string, bucket: string, now: Date): Promise<void> {
  try {
    const user = await db.user.findUnique({ where: { id: ownerId }, select: { balanceMicros: true } });
    await db.ledgerEntry.upsert({
      where: { idempotencyKey: `host-unpaid:${botId}:${bucket}` },
      create: {
        userId: ownerId,
        kind: 'usage',
        feature: 'hosting_day',
        amountMicros: 0,
        balanceAfter: user?.balanceMicros ?? 0,
        bucket,
        refId: botId,
        idempotencyKey: `host-unpaid:${botId}:${bucket}`,
        note: 'unpaid — out of credits',
        metaJson: JSON.stringify({ at: now.toISOString() }),
      },
      update: {},
    });
    await db.bot.update({
      where: { id: botId },
      data: { statusDetail: 'Hosting unpaid — top up in Billing to keep this bot running.' },
    }).catch(() => undefined);
  } catch {
    /* audit best-effort */
  }
}

/** Distinct unpaid days for this bot in the last UNPAID_STOP_AFTER_DAYS days. */
async function countUnpaidDays(botId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - UNPAID_STOP_AFTER_DAYS * 24 * 3600_000);
  const rows = await db.ledgerEntry.findMany({
    where: {
      refId: botId,
      feature: 'hosting_day',
      note: 'unpaid — out of credits',
      createdAt: { gte: since },
    },
    select: { bucket: true },
  });
  return new Set(rows.map((r) => r.bucket)).size;
}

async function stopUnpaidBot(bot: { id: string; transport: string | null; telegramTokenRef: string | null }): Promise<void> {
  // Webhook bots: the kill switch is deleteWebhook (updates stop arriving).
  if (bot.transport === 'webhook' && bot.telegramTokenRef) {
    try {
      const { SecretManager } = await import('../secrets');
      const token = SecretManager.decrypt(bot.telegramTokenRef);
      await new TelegramAdapter({ token }).deleteWebhook();
    } catch {
      /* wallet gate keeps the bot silent even if this fails */
    }
  }
  await db.bot.update({
    where: { id: bot.id },
    data: {
      status: 'stopped',
      statusDetail: 'Stopped: hosting unpaid for 3 days. Top up in Billing and restart.',
    },
  }).catch(() => undefined);
}
