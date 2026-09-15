/**
 * NURAE — plan tests (Task 27): subscriptions on top of pay-as-you-use.
 *
 *   - catalog integrity (client-safe pure data)
 *   - subscribeToPlan: wallet charge, expiry, same-plan stacking, switching,
 *     insufficient balance (exact amounts), unknown plans, ledger journal
 *   - planMultiplier: free daily allowances scale with the plan inside
 *     chargeFeature (and not for trial/premium free-rides)
 *   - hosting waiver: paid plans cover the first N running bots
 *   - walletSummary exposes the plan view with boosted allowances
 */

import { describe, expect, test, afterAll } from 'vitest';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const { PLANS, planSpec } = await import('../../src/lib/nurae/billing/plan-catalog');
const {
  activePlan,
  planHostingCover,
  planMultiplier,
  subscribeToPlan,
} = await import('../../src/lib/nurae/billing/plans');
const {
  chargeFeature,
  ensurePricingCatalog,
  walletSummary,
} = await import('../../src/lib/nurae/billing/wallet');
const { runDailyHostingBilling } = await import('../../src/lib/nurae/billing/hosting');
const { ensureSignupTrial } = await import('../../src/lib/nurae/billing/wallet');
const { createUserBot } = await import('../../src/lib/nurae/bots/user-bots');

let counter = 0;

async function makeUser(opts?: { trial?: boolean }): Promise<{ id: string; email: string }> {
  counter += 1;
  const email = `t27p-${counter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const user = await db.user.create({
    data: {
      name: `T27 Plan User ${counter}`,
      email,
      passwordHash: await hashPassword('password123'),
      emailVerified: true,
    },
  });
  if (opts?.trial) await ensureSignupTrial(user.id);
  return { id: user.id, email };
}

async function pastTrial(userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
}

async function grant(userId: string, micros: number): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { balanceMicros: micros } });
}

async function makeBot(userId: string): Promise<string> {
  const created = await createUserBot(userId, { name: `PlanBot ${Date.now()}-${counter}` });
  expect(created.bot).toBeTruthy();
  await db.bot.update({ where: { id: created.bot!.id }, data: { status: 'running', enabled: true } });
  return created.bot!.id;
}

afterAll(async () => {
  // restore the ai_reply price row this file tunes
  await db.pricingRule.updateMany({ where: { feature: 'ai_reply' }, data: { freeDailyUnits: 50 } }).catch(() => undefined);
});

// ---------------------------------------------------------------------------

describe('plan catalog', () => {
  test('three tiers, additive perks, sane numbers', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['free', 'plus', 'pro']);
    const plus = planSpec('plus');
    const pro = planSpec('pro');
    expect(plus.monthlyMicros).toBe(4_990_000);
    expect(pro.monthlyMicros).toBe(19_990_000);
    expect(plus.dailyMultiplier).toBe(3);
    expect(pro.dailyMultiplier).toBe(10);
    expect(plus.includedHostingBots).toBe(3);
    expect(pro.includedHostingBots).toBe(15);
    expect(planSpec('free').dailyMultiplier).toBe(1);
    expect(planSpec('who-dis')).toEqual(PLANS[0]); // unknown → free
    for (const p of PLANS) expect(p.perks.length).toBeGreaterThan(0);
  });
});

describe('subscribeToPlan', () => {
  test('unknown plan and free plan are refused', async () => {
    const u = await makeUser();
    expect((await subscribeToPlan(u.id, 'nope')).ok).toBe(false);
    expect((await subscribeToPlan(u.id, 'free')).ok).toBe(false);
  });

  test('insufficient balance returns 402-style detail with exact amounts', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 4_990_000 - 1); // one micro short
    const result = await subscribeToPlan(u.id, 'plus');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'insufficient') {
      expect(result.needed).toBe(4_990_000);
      expect(result.balanceMicros).toBe(4_990_000 - 1);
    } else {
      expect.unreachable('expected insufficient');
    }
  });

  test('success debits the wallet, sets a 30-day window, journals the ledger', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 10_000_000);
    const result = await subscribeToPlan(u.id, 'plus');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.id).toBe('plus');
      const days = (result.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      expect(result.balanceMicros).toBe(10_000_000 - 4_990_000);
    }
    const stored = await db.user.findUnique({ where: { id: u.id } });
    expect(stored?.planId).toBe('plus');
    const ledger = await db.ledgerEntry.findFirst({ where: { userId: u.id, kind: 'subscription' } });
    expect(ledger?.amountMicros).toBe(-4_990_000);
    expect(ledger?.feature).toBe('plan_plus');
  });

  test('same-plan renewal stacks from the existing expiry; switching restarts', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 50_000_000);

    const first = await subscribeToPlan(u.id, 'plus');
    expect(first.ok).toBe(true);
    const firstExpiry = (first as { expiresAt: Date }).expiresAt;

    // Renew 10 days in → the new expiry sits ~30 days past the CURRENT one.
    await new Promise((r) => setTimeout(r, 5));
    const renewed = await subscribeToPlan(u.id, 'plus');
    expect(renewed.ok).toBe(true);
    const renewedExpiry = (renewed as { expiresAt: Date }).expiresAt;
    const stackedDays = (renewedExpiry.getTime() - firstExpiry.getTime()) / 86_400_000;
    expect(stackedDays).toBeGreaterThan(29.9);

    // Switching to Pro starts a fresh window from now.
    const switched = await subscribeToPlan(u.id, 'pro');
    expect(switched.ok).toBe(true);
    const switchedExpiry = (switched as { expiresAt: Date }).expiresAt;
    expect(switchedExpiry.getTime()).toBeLessThan(renewedExpiry.getTime());
    const freshDays = (switchedExpiry.getTime() - Date.now()) / 86_400_000;
    expect(freshDays).toBeGreaterThan(29.9);
    expect(freshDays).toBeLessThan(30.5);
    const stored = await db.user.findUnique({ where: { id: u.id } });
    expect(stored?.planId).toBe('pro');
  });

  test('activePlan resolves the multiplier and expiry honestly', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    expect((await activePlan(u.id)).active).toBe(false);
    expect((await activePlan(u.id)).spec.id).toBe('free');

    await grant(u.id, 20_000_000);
    await subscribeToPlan(u.id, 'pro');
    const plan = await activePlan(u.id);
    expect(plan.active).toBe(true);
    expect(plan.spec.id).toBe('pro');

    // Expired plan → back to free.
    await db.user.update({
      where: { id: u.id },
      data: { planExpiresAt: new Date(Date.now() - 3_600_000) },
    });
    expect((await activePlan(u.id)).active).toBe(false);
    expect((await planMultiplier(u.id))).toBe(1);
  });
});

describe('plan multiplier inside chargeFeature', () => {
  test('Plus ×3 boosts the free daily allowance (no boost without a plan)', async () => {
    await ensurePricingCatalog();
    // Tune ai_reply down so the test stays small (restored in afterAll).
    // Quota counting is ROW-based: every chargeFeature call writes one ledger
    // row, and free rows still count toward the day.
    await db.pricingRule.update({ where: { feature: 'ai_reply' }, data: { freeDailyUnits: 2 } });

    const freeUser = await makeUser();
    await pastTrial(freeUser.id);
    await grant(freeUser.id, 1_000_000); // beyond quota the charge must actually succeed
    try {
      expect((await chargeFeature(freeUser.id, 'ai_reply')).outcome).toBe('free_quota'); // row 1/2
      expect((await chargeFeature(freeUser.id, 'ai_reply')).outcome).toBe('free_quota'); // row 2/2
      const third = await chargeFeature(freeUser.id, 'ai_reply');
      expect(third.outcome).toBe('charged'); // row 3 — beyond the base allowance
      expect(third.chargedMicros).toBe(1_500);

      const plusUser = await makeUser();
      await pastTrial(plusUser.id);
      await grant(plusUser.id, 10_000_000);
      await subscribeToPlan(plusUser.id, 'plus'); // ×3 → 2 free rows becomes 6
      for (let i = 0; i < 6; i += 1) {
        expect((await chargeFeature(plusUser.id, 'ai_reply')).outcome).toBe('free_quota');
      }
      const seventh = await chargeFeature(plusUser.id, 'ai_reply');
      expect(seventh.outcome).toBe('charged'); // row 7 — beyond the boosted allowance
      expect(seventh.chargedMicros).toBe(1_500);
    } finally {
      // restore immediately — later tests read this rule
      await db.pricingRule.update({ where: { feature: 'ai_reply' }, data: { freeDailyUnits: 50 } });
    }
  });

  test('trial users are unaffected (already free) — multiplier only resolves past free-ride', async () => {
    const u = await makeUser({ trial: true });
    const result = await chargeFeature(u.id, 'ai_reply', { units: 999 });
    expect(result.outcome).toBe('trial');
    expect(result.chargedMicros).toBe(0);
  });

  test('walletSummary shows the plan view with boosted allowances', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 10_000_000);
    await subscribeToPlan(u.id, 'plus');
    const summary = await walletSummary(u.id);
    expect(summary.plan.active).toBe(true);
    expect(summary.plan.id).toBe('plus');
    expect(summary.plan.dailyMultiplier).toBe(3);
    const aiReply = summary.usageToday.find((f) => f.feature === 'ai_reply');
    expect(aiReply?.freeDailyUnits).toBe(50 * 3); // catalog base × plan boost
  });
});

describe('plan hosting cover', () => {
  test('a Pro plan covers the first 15 running bots — the pass records free rows', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 0); // deliberately broke — only the plan can cover hosting
    const botA = await makeBot(u.id);
    const botB = await makeBot(u.id);
    await db.user.update({ where: { id: u.id }, data: { planId: 'pro', planExpiresAt: new Date(Date.now() + 86_400_000) } });

    expect(await planHostingCover(u.id, botA)).not.toBeNull();
    expect(await planHostingCover(u.id, botB)).not.toBeNull();

    const result = await runDailyHostingBilling();
    const rows = await db.ledgerEntry.findMany({ where: { userId: u.id, feature: 'hosting_day' } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.amountMicros === 0 && r.note?.startsWith('plan_hosting'))).toBe(true);
    expect(result.unpaid).toBeGreaterThanOrEqual(0); // this user contributed no unpaid rows
    const stopped = await db.bot.findUnique({ where: { id: botA } });
    expect(stopped?.status).toBe('running'); // never stopped while covered
  });

  test('beyond the covered quota the day is billed (or marked unpaid) normally', async () => {
    const u = await makeUser();
    await pastTrial(u.id);
    await grant(u.id, 0); // no balance → the 4th bot must land as unpaid
    for (let i = 0; i < 4; i += 1) await makeBot(u.id);
    await db.user.update({ where: { id: u.id }, data: { planId: 'plus', planExpiresAt: new Date(Date.now() + 86_400_000) } });

    const bots = await db.bot.findMany({ where: { ownerId: u.id }, orderBy: { createdAt: 'asc' } });
    expect(await planHostingCover(u.id, bots[0].id)).not.toBeNull(); // covered
    expect(await planHostingCover(u.id, bots[3].id)).toBeNull(); // beyond the 3-bot quota

    await runDailyHostingBilling();
    const unpaid = await db.ledgerEntry.findMany({
      where: { userId: u.id, feature: 'hosting_day', note: 'unpaid — out of credits' },
    });
    expect(unpaid.length).toBe(1); // exactly the bot outside the plan quota
    const covered = await db.ledgerEntry.findMany({
      where: { userId: u.id, feature: 'hosting_day', note: { startsWith: 'plan_hosting' } },
    });
    expect(covered.length).toBe(3);
  });

  test('no plan → no cover (the trial/premium paths belong to the wallet)', async () => {
    const u = await makeUser();
    const botId = await makeBot(u.id);
    expect(await planHostingCover(u.id, botId)).toBeNull();
  });
});
