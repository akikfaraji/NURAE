/**
 * NURAE — subscription plans on top of pay-as-you-use.
 *
 * Pay-as-you-use stays the metering backbone (billing/catalog.ts). Plans are
 * PURELY ADDITIVE perks bought with wallet credit (Stars / crypto topups feed
 * the same wallet) — the free tier never shrinks, nothing is ever taken away:

 *   free  $0       — the base free daily allowances, hosting billed per day
 *   plus  $4.99/mo — every free daily allowance ×3, hosting included for up
 *                    to 3 running bots
 *   pro   $19.99/mo— every free daily allowance ×10, hosting included for up
 *                    to 15 running bots
 *
 * A plan is a row on the User (planId + planExpiresAt). Subscriptions are
 * paid from the wallet (subscribeToPlan): renewing the same plan stacks onto
 * the existing expiry; switching plans starts a fresh 30 days from now. The
 * referral "premium" entitlement (all usage free) still outranks plans —
 * plans make the allowances bigger, premium makes usage free.
 *
 * Money is integer micro-dollars (µ$): 1,000,000 µ$ = $1.00.
 */

import { db } from '@/lib/db';
import { PLANS, planSpec, type PlanId, type PlanSpec } from './plan-catalog';

export { PLANS, planSpec };
export type { PlanId, PlanSpec };

export interface ActivePlan {
  spec: PlanSpec;
  expiresAt: Date | null;
  /** True when the plan window covers `now`. */
  active: boolean;
}

/**
 * The user's plan state. Trial / premium free-ride is intentionally NOT
 * consulted here — the wallet resolves those separately; plans only boost
 * the daily allowances and cover hosting.
 */
export async function activePlan(userId: string, now: Date = new Date()): Promise<ActivePlan> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { planId: true, planExpiresAt: true },
  });
  const expiresAt = user?.planExpiresAt ?? null;
  const spec = planSpec(user?.planId);
  const active = Boolean(expiresAt && expiresAt.getTime() > now.getTime() && spec.id !== 'free');
  // An expired/absent paid plan resolves to the free spec with no window.
  return active ? { spec, expiresAt, active } : { spec: PLANS[0], expiresAt: null, active: false };
}

/** Free-daily-units multiplier for a user (1 unless a paid plan is active). */
export async function planMultiplier(userId: string, now: Date = new Date()): Promise<number> {
  const plan = await activePlan(userId, now);
  return plan.active ? plan.spec.dailyMultiplier : 1;
}

export type SubscribeResult =
  | { ok: true; plan: PlanSpec; expiresAt: Date; balanceMicros: number }
  | { ok: false; reason: 'unknown_plan' }
  | { ok: false; reason: 'insufficient'; needed: number; balanceMicros: number };

const PLAN_DAYS = 30;

/**
 * Buy (or extend) a plan with wallet credit. Same-plan renewals stack onto
 * the current expiry so early renewals never lose days; switching plans
 * starts fresh. The charge is atomic (the debit only matches sufficient
 * balances) and journaled in the ledger with an idempotency key per period.
 */
export async function subscribeToPlan(userId: string, planId: string, now: Date = new Date()): Promise<SubscribeResult> {
  const spec = PLANS.find((p) => p.id === planId);
  if (!spec || spec.id === 'free') return { ok: false, reason: 'unknown_plan' };

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { balanceMicros: true, planId: true, planExpiresAt: true },
  });
  if (!user) return { ok: false, reason: 'unknown_plan' };

  const currentActive = Boolean(user.planExpiresAt && user.planExpiresAt.getTime() > now.getTime());
  // Same plan → stack from the existing expiry; otherwise start from now.
  const periodStart =
    currentActive && user.planId === spec.id ? (user.planExpiresAt as Date) : now;
  const expiresAt = new Date(periodStart.getTime() + PLAN_DAYS * 24 * 60 * 60 * 1000);
  const idempotencyKey = `plan:${userId}:${spec.id}:${periodStart.toISOString().slice(0, 10)}T${periodStart
    .toISOString()
    .slice(11, 19)}`;

  // Replay of an already-journaled period → return the existing state.
  const existing = await db.ledgerEntry.findUnique({ where: { idempotencyKey }, select: { id: true } });
  if (existing) {
    const fresh = await db.user.findUnique({ where: { id: userId }, select: { planExpiresAt: true, balanceMicros: true } });
    return {
      ok: true,
      plan: spec,
      expiresAt: (fresh?.planExpiresAt as Date) ?? expiresAt,
      balanceMicros: fresh?.balanceMicros ?? user.balanceMicros,
    };
  }

  const updated = await db.user.updateMany({
    where: { id: userId, balanceMicros: { gte: spec.monthlyMicros } },
    data: { balanceMicros: { decrement: spec.monthlyMicros } },
  });
  if (updated.count === 0) {
    return { ok: false, reason: 'insufficient', needed: spec.monthlyMicros, balanceMicros: user.balanceMicros };
  }

  const balanceMicros = await db
    .user.update({
      where: { id: userId },
      data: { planId: spec.id, planExpiresAt: expiresAt },
      select: { balanceMicros: true },
    })
    .then((u) => u.balanceMicros);

  await db.ledgerEntry.create({
    data: {
      userId,
      kind: 'subscription',
      feature: `plan_${spec.id}`,
      amountMicros: -spec.monthlyMicros,
      balanceAfter: balanceMicros,
      bucket: now.toISOString().slice(0, 10),
      refId: spec.id,
      idempotencyKey,
      note: `${spec.name} plan — 30 days (until ${expiresAt.toISOString().slice(0, 10)})`,
    },
  });

  return { ok: true, plan: spec, expiresAt, balanceMicros };
}

/**
 * Hosting waiver for one bot: a paid plan covers the first
 * `includedHostingBots` running bots (stable order: oldest bot first, so
 * the waiver cannot be gamed by restart juggling). Returns the plan that
 * covers it, or null when the day must be billed normally.
 */
export async function planHostingCover(ownerId: string, botId: string, now: Date = new Date()): Promise<PlanSpec | null> {
  const plan = await activePlan(ownerId, now);
  if (!plan.active || plan.spec.includedHostingBots <= 0) return null;
  const bots = await db.bot.findMany({
    where: { ownerId, enabled: true, status: 'running' },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const rank = bots.findIndex((b) => b.id === botId);
  return rank >= 0 && rank < plan.spec.includedHostingBots ? plan.spec : null;
}
