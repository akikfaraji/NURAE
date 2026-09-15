/**
 * NURAE — wallet: balance, free-ride resolution and per-feature charging.
 *
 * Rules (in order of generosity — the first match wins):
 *   1. TRIAL   — every new account gets 7 free days (the "free server" week).
 *   2. PREMIUM — an active "premium" entitlement (earned via referrals) makes
 *                all usage free while it lasts.
 *   3. QUOTA   — each feature has free daily units (midnight UTC reset).
 *   4. BALANCE — everything beyond that is charged per unit from the wallet.
 *
 * Every metered call writes a LedgerEntry row (free rows too, amount 0), so
 * usage analytics and quota accounting read the same journal. Charging is
 * atomic: the balance UPDATE only matches rows with sufficient funds.
 *
 * Billing must never break a conversation: callers wrap charges defensively
 * and treat `skipped` as "don't send, log honestly".
 */

import { db } from '@/lib/db';
import {
  DEFAULT_CATALOG,
  FEATURE_KEYS,
  dayBucket,
  featureSpec,
  trialEndsForNewUser,
} from './catalog';
import { activePlan, planMultiplier } from './plans';

export type ChargeOutcome = 'trial' | 'premium' | 'free_quota' | 'charged' | 'skipped';

export interface ChargeResult {
  outcome: ChargeOutcome;
  /** What was actually deducted (0 for all free outcomes). */
  chargedMicros: number;
  units: number;
}

export interface ChargeOptions {
  /** Units to consume (default 1 — e.g. messages, MB, rounds). */
  units?: number;
  /** Context id (bot id, session id…) recorded on the ledger row. */
  refId?: string;
  /** Replay-safe key — identical keys never charge twice (hosting days). */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Price book (seeded from DEFAULT_CATALOG on first read; admin-editable)
// ---------------------------------------------------------------------------

let catalogSeeded = false;

/** One-time seeding of PricingRule rows; safe to call concurrently. */
export async function ensurePricingCatalog(): Promise<void> {
  if (catalogSeeded) return;
  for (const spec of DEFAULT_CATALOG) {
    await db.pricingRule.upsert({
      where: { feature: spec.key },
      // Existing rows (operator-tuned) are never overwritten by the seed.
      create: {
        feature: spec.key,
        unitPriceMicros: spec.unitPriceMicros,
        freeDailyUnits: spec.freeDailyUnits,
        displayName: spec.displayName,
        description: spec.description,
        enabled: true,
      },
      update: {},
    });
  }
  catalogSeeded = true;
}

export interface PriceRow {
  feature: string;
  displayName: string;
  description: string;
  unit: string;
  unitPriceMicros: number;
  freeDailyUnits: number;
  enabled: boolean;
  hardGate: boolean;
}

/** Effective price book (DB rows overlaid on the compiled specs). */
export async function getPriceBook(): Promise<PriceRow[]> {
  await ensurePricingCatalog();
  const rows = await db.pricingRule.findMany({ where: { feature: { in: FEATURE_KEYS } } });
  const byFeature = new Map(rows.map((r) => [r.feature, r]));
  return DEFAULT_CATALOG.map((spec) => {
    const row = byFeature.get(spec.key);
    return {
      feature: spec.key,
      displayName: row?.displayName ?? spec.displayName,
      description: spec.description,
      unit: spec.unit,
      unitPriceMicros: row?.unitPriceMicros ?? spec.unitPriceMicros,
      freeDailyUnits: row?.freeDailyUnits ?? spec.freeDailyUnits,
      enabled: row?.enabled ?? true,
      hardGate: spec.hardGate,
    };
  });
}

// ---------------------------------------------------------------------------
// Free-ride sources
// ---------------------------------------------------------------------------

export interface FreeRide {
  mode: 'trial' | 'premium' | null;
  trialEndsAt: Date | null;
  premiumEndsAt: Date | null;
}

export async function resolveFreeRide(userId: string, now: Date = new Date()): Promise<FreeRide> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { trialEndsAt: true },
  });
  const trialEndsAt = user?.trialEndsAt ?? null;
  if (trialEndsAt && trialEndsAt.getTime() > now.getTime()) {
    return { mode: 'trial', trialEndsAt, premiumEndsAt: null };
  }
  const premium = await db.entitlement.findFirst({
    where: { userId, feature: 'premium', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    select: { expiresAt: true },
  });
  if (premium) {
    return { mode: 'premium', trialEndsAt, premiumEndsAt: premium.expiresAt };
  }
  return { mode: null, trialEndsAt, premiumEndsAt: null };
}

/** Called at signup (email + Google paths): starts the 7-day free server week. */
export async function ensureSignupTrial(userId: string, now: Date = new Date()): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { trialEndsAt: true } });
  if (!user || user.trialEndsAt) return; // never shorten or double-grant
  await db.user.update({ where: { id: userId }, data: { trialEndsAt: trialEndsForNewUser(now) } });
}

// ---------------------------------------------------------------------------
// Credits (topups, grants, refunds) — idempotent
// ---------------------------------------------------------------------------

export interface CreditParams {
  userId: string;
  micros: number;
  kind: 'topup' | 'grant' | 'refund' | 'adjustment';
  idempotencyKey?: string;
  note?: string;
  refId?: string;
  meta?: Record<string, unknown>;
}

export interface CreditResult {
  applied: boolean;
  balance: number;
}

/** Add money to a wallet. With an idempotencyKey, replays are no-ops. */
export async function creditWallet(params: CreditParams): Promise<CreditResult> {
  const micros = Math.round(params.micros);
  if (micros === 0) return { applied: false, balance: await getBalance(params.userId) };
  if (micros < 0) throw new Error('creditWallet refused a negative amount — use chargeFeature for debits');

  if (params.idempotencyKey) {
    const existing = await db.ledgerEntry.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      const user = await db.user.findUnique({ where: { id: params.userId }, select: { balanceMicros: true } });
      return { applied: false, balance: user?.balanceMicros ?? 0 };
    }
  }

  const user = await db.user.update({
    where: { id: params.userId },
    data: { balanceMicros: { increment: micros } },
    select: { balanceMicros: true },
  });
  await db.ledgerEntry.create({
    data: {
      userId: params.userId,
      kind: params.kind,
      amountMicros: micros,
      balanceAfter: user.balanceMicros,
      refId: params.refId ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      note: params.note ?? null,
      metaJson: params.meta ? JSON.stringify(params.meta) : null,
    },
  });
  return { applied: true, balance: user.balanceMicros };
}

export async function getBalance(userId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { balanceMicros: true } });
  return user?.balanceMicros ?? 0;
}

// ---------------------------------------------------------------------------
// Charging (usage)
// ---------------------------------------------------------------------------

/**
 * Consume `units` of a feature for a user. Writes exactly one ledger row per
 * call (unless the feature is disabled or the charge is skipped — then none,
 * so skipped events never count toward the daily free quota).
 */
export async function chargeFeature(
  userId: string,
  feature: string,
  opts: ChargeOptions = {},
): Promise<ChargeResult> {
  const units = Math.max(0, Math.round(opts.units ?? 1));
  if (units === 0) return { outcome: 'free_quota', chargedMicros: 0, units: 0 };

  const spec = featureSpec(feature);
  if (!spec) return { outcome: 'free_quota', chargedMicros: 0, units };

  await ensurePricingCatalog();
  const rule = await db.pricingRule.findUnique({ where: { feature } });
  if (rule && !rule.enabled) return { outcome: 'free_quota', chargedMicros: 0, units };

  const unitPrice = rule?.unitPriceMicros ?? spec.unitPriceMicros;
  const freeDaily = rule?.freeDailyUnits ?? spec.freeDailyUnits;
  const bucket = dayBucket();

  // Idempotent replay → already consumed.
  if (opts.idempotencyKey) {
    const existing = await db.ledgerEntry.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { outcome: 'charged', chargedMicros: 0, units };
  }

  const freeRide = await resolveFreeRide(userId);
  // Paid plans boost the free daily allowance (×3 Plus / ×10 Pro). The boost
  // is only resolved when it can matter — trial/premium free-rides skip it.
  const planBoost = freeRide.mode ? 1 : await planMultiplier(userId);
  const base = {
    userId,
    kind: 'usage' as const,
    feature,
    unitCount: units,
    bucket,
    refId: opts.refId ?? null,
    metaJson: opts.idempotencyKey
      ? JSON.stringify({ idem: opts.idempotencyKey })
      : undefined,
  };
  const idemData = opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {};

  if (freeRide.mode) {
    const row = await db.ledgerEntry.create({
      data: { ...base, amountMicros: 0, balanceAfter: await getBalance(userId), note: freeRide.mode, ...idemData },
    });
    void row;
    return { outcome: freeRide.mode === 'trial' ? 'trial' : 'premium', chargedMicros: 0, units };
  }

  // Daily free quota: today's ledger rows for this feature (any outcome) count.
  // Plans multiply the allowance, never the price.
  const effectiveFreeDaily = freeDaily * planBoost;
  let freeUnits = 0;
  if (effectiveFreeDaily > 0) {
    const used = await db.ledgerEntry.count({
      where: { userId, feature, bucket },
    });
    freeUnits = Math.max(0, Math.min(effectiveFreeDaily - used, units));
  }
  const billable = units - freeUnits;
  const cost = billable * unitPrice;

  if (cost === 0) {
    await db.ledgerEntry.create({
      data: { ...base, amountMicros: 0, balanceAfter: await getBalance(userId), note: 'free_quota', ...idemData },
    });
    return { outcome: 'free_quota', chargedMicros: 0, units };
  }

  // Atomic debit: the UPDATE matches only when the balance covers the cost.
  const updated = await db.user.updateMany({
    where: { id: userId, balanceMicros: { gte: cost } },
    data: { balanceMicros: { decrement: cost } },
  });
  if (updated.count === 0) {
    return { outcome: 'skipped', chargedMicros: cost, units };
  }
  const balanceAfter = await getBalance(userId);
  await db.ledgerEntry.create({
    data: { ...base, amountMicros: -cost, balanceAfter, note: freeUnits > 0 ? `charged ${billable}/${units} (free ${freeUnits})` : null, ...idemData },
  });
  return { outcome: 'charged', chargedMicros: cost, units };
}

// ---------------------------------------------------------------------------
// Summary (API/UI)
// ---------------------------------------------------------------------------

export interface FeatureUsageToday {
  feature: string;
  used: number;
  freeDailyUnits: number;
  unitPriceMicros: number;
  chargedTodayMicros: number;
}

export interface WalletPlanView {
  id: string;
  name: string;
  active: boolean;
  expiresAt: string | null;
  dailyMultiplier: number;
  includedHostingBots: number;
}

export interface WalletSummary {
  balanceMicros: number;
  freeRide: FreeRide;
  plan: WalletPlanView;
  usageToday: FeatureUsageToday[];
  prices: PriceRow[];
}

export async function walletSummary(userId: string): Promise<WalletSummary> {
  const [balanceMicros, freeRide, prices, plan] = await Promise.all([
    getBalance(userId),
    resolveFreeRide(userId),
    getPriceBook(),
    activePlan(userId),
  ]);
  const bucket = dayBucket();
  const grouped = await db.ledgerEntry.groupBy({
    by: ['feature'],
    where: { userId, kind: 'usage', bucket },
    _count: { _all: true },
    _sum: { amountMicros: true },
  });
  const byFeature = new Map(grouped.map((g) => [g.feature ?? '', g]));
  const boost = plan.active ? plan.spec.dailyMultiplier : 1;
  const usageToday: FeatureUsageToday[] = prices.map((p) => {
    const g = byFeature.get(p.feature);
    return {
      feature: p.feature,
      used: g?._count._all ?? 0,
      freeDailyUnits: p.freeDailyUnits * boost,
      unitPriceMicros: p.unitPriceMicros,
      chargedTodayMicros: Math.abs(g?._sum.amountMicros ?? 0),
    };
  });
  return {
    balanceMicros,
    freeRide,
    plan: {
      id: plan.spec.id,
      name: plan.spec.name,
      active: plan.active,
      expiresAt: plan.expiresAt?.toISOString() ?? null,
      dailyMultiplier: plan.spec.dailyMultiplier,
      includedHostingBots: plan.spec.includedHostingBots,
    },
    usageToday,
    prices,
  };
}

export interface LedgerRowView {
  id: string;
  kind: string;
  feature: string | null;
  amountMicros: number;
  balanceAfter: number;
  unitCount: number;
  note: string | null;
  refId: string | null;
  createdAt: string;
}

export async function recentLedger(userId: string, limit = 50): Promise<LedgerRowView[]> {
  const rows = await db.ledgerEntry.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    feature: r.feature,
    amountMicros: r.amountMicros,
    balanceAfter: r.balanceAfter,
    unitCount: r.unitCount,
    note: r.note,
    refId: r.refId,
    createdAt: r.createdAt.toISOString(),
  }));
}
