/**
 * NURAE — billing tests (Task 24): the pay-as-you-use layer.
 *
 * Covers the wallet (trial / premium / free-quota / charged / skipped),
 * idempotent credits, the metered sender gate, broadcast + schedule
 * enforcement, Stars topups (order → successful_payment → credit, idempotent),
 * manual crypto topups (address → tx hash → admin approval) and the daily
 * hosting pass (free during trial, charged after, stop after 3 unpaid days).
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub } from './telegram-stub';

import { pushTestSchema } from './helpers';
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { hashPassword } = await import('../../src/lib/nurae/auth/passwords');
const {
  dayBucket,
  formatUsd,
  parseTopupPayload,
  starsRateMicros,
} = await import('../../src/lib/nurae/billing/catalog');
const {
  chargeFeature,
  creditWallet,
  ensureSignupTrial,
  getPriceBook,
  walletSummary,
} = await import('../../src/lib/nurae/billing/wallet');
const {
  TopupError,
  approveTopup,
  completeStarsTopup,
  createCryptoTopup,
  createStarsTopup,
  pollCryptoTopups,
  rejectTopup,
  submitCryptoTx,
} = await import('../../src/lib/nurae/billing/topups');
const { runDailyHostingBilling } = await import('../../src/lib/nurae/billing/hosting');
const { meteredSender } = await import('../../src/lib/nurae/billing/meter-sender');
const { createPrismaRuntimeStore } = await import('../../src/lib/nurae/runtime/store');
const { runDueBotWork } = await import('../../src/lib/nurae/runtime/tasks');
const { createUserBot } = await import('../../src/lib/nurae/bots/user-bots');
const { grantEntitlement } = await import('../../src/lib/nurae/referral');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

const STUB_TOKEN = '1112223334:EcoTestTokenNotRealButWellFormedAAAA';

let counter = 0;

async function makeUser(opts?: { trial?: boolean; verified?: boolean }): Promise<{ id: string; email: string }> {
  counter += 1;
  const email = `t24-${counter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const user = await db.user.create({
    data: {
      name: `T24 User ${counter}`,
      email,
      passwordHash: await hashPassword('password123'),
      emailVerified: opts?.verified ?? true,
    },
  });
  if (opts?.trial) await ensureSignupTrial(user.id);
  return { id: user.id, email };
}

async function makeBot(userId: string, extra?: { status?: string; transport?: string | null }) {
  const created = await createUserBot(userId, {
    name: `BillBot ${Date.now()}-${counter}`,
    systemPrompt: 'Test bot.',
  });
  expect(created.bot).toBeTruthy();
  const botId = created.bot!.id;
  await db.bot.update({
    where: { id: botId },
    data: {
      status: extra?.status ?? 'running',
      transport: extra?.transport ?? 'webhook',
      telegramTokenRef: SecretManager.encrypt(STUB_TOKEN),
    },
  });
  const store = createPrismaRuntimeStore(db);
  const record = await store.getBot(botId);
  return { botId, record: record!, store };
}

function fakeSender(spy: { sends: string[] }) {
  return {
    sendMessage: async (chatId: number | string, text: string) => {
      spy.sends.push(`${chatId}:${text}`);
    },
  };
}

/** A user whose trial is over and whose balance is empty. */
async function pastTrialUser(): Promise<{ id: string }> {
  const u = await makeUser();
  await db.user.update({ where: { id: u.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
  return u;
}

afterAll(() => {
  // restore any env this file touched (defensive — each process is isolated)
  delete process.env.NURAE_CRYPTO_ADDRESS_TON;
  delete process.env.NURAE_CRYPTOBOT_API_TOKEN;
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('billing catalog', () => {
  test('formatUsd renders micro-dollar amounts honestly', async () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(1_500_000)).toBe('$1.5');
    expect(formatUsd(15_000_000)).toBe('$15');
    expect(formatUsd(50)).toBe('$0.00005');
    expect(formatUsd(-50)).toBe('-$0.00005');
  });

  test('dayBucket is a UTC day key', async () => {
    expect(dayBucket(new Date('2026-09-15T13:24:00Z'))).toBe('2026-09-15');
  });

  test('parseTopupPayload accepts only platform-shaped payloads', async () => {
    expect(parseTopupPayload('nurae_topup_TABC123')).toBe('TABC123');
    expect(parseTopupPayload('nurae_topup_')).toBeNull();
    expect(parseTopupPayload('p_buy_0')).toBeNull();
    expect(parseTopupPayload('')).toBeNull();
  });

  test('price book seeds all catalog features', async () => {
    const book = await getPriceBook();
    const keys = book.map((p: { feature: string }) => p.feature);
    expect(keys).toContain('ai_reply');
    expect(keys).toContain('bot_message');
    expect(keys).toContain('hosting_day');
  });
});

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

describe('wallet', () => {
  test('ensureSignupTrial grants 7 days exactly once', async () => {
    const u = await makeUser();
    await ensureSignupTrial(u.id);
    const first = await db.user.findUnique({ where: { id: u.id }, select: { trialEndsAt: true } });
    expect(first?.trialEndsAt).toBeTruthy();
    const days = (first!.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7.1);
    // Never shortened or re-granted.
    const shortened = new Date(Date.now() + 86_400_000);
    await db.user.update({ where: { id: u.id }, data: { trialEndsAt: shortened } });
    await ensureSignupTrial(u.id);
    const second = await db.user.findUnique({ where: { id: u.id }, select: { trialEndsAt: true } });
    expect(second!.trialEndsAt!.getTime()).toBe(shortened.getTime());
  });

  test('trial users ride free — usage recorded at zero cost', async () => {
    const u = await makeUser({ trial: true });
    const result = await chargeFeature(u.id, 'ai_reply');
    expect(result.outcome).toBe('trial');
    expect(result.chargedMicros).toBe(0);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(0);
    const row = await db.ledgerEntry.findFirst({ where: { userId: u.id, feature: 'ai_reply' } });
    expect(row?.amountMicros).toBe(0);
    expect(row?.note).toBe('trial');
  });

  test('premium entitlement rides free', async () => {
    const u = await pastTrialUser();
    await grantEntitlement(u.id, 'premium', 1, 'test');
    const result = await chargeFeature(u.id, 'ai_build');
    expect(result.outcome).toBe('premium');
    expect(result.chargedMicros).toBe(0);
  });

  test('free quota absorbs the first units, balance pays beyond, skip when empty', async () => {
    const u = await pastTrialUser();
    // file_upload_mb: 20 free/day, $0.002 per MB.
    for (let i = 0; i < 20; i++) {
      const r = await chargeFeature(u.id, 'file_upload_mb');
      expect(r.outcome).toBe('free_quota');
    }
    const skipped = await chargeFeature(u.id, 'file_upload_mb');
    expect(skipped.outcome).toBe('skipped');
    expect(skipped.chargedMicros).toBe(2_000);

    // Top up → the same unit now charges and the wallet debits atomically.
    await creditWallet({ userId: u.id, micros: 1_000_000, kind: 'topup', note: 'test' });
    const charged = await chargeFeature(u.id, 'file_upload_mb');
    expect(charged.outcome).toBe('charged');
    expect(charged.chargedMicros).toBe(2_000);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(998_000);

    // 21 ledger rows for the feature today (free + skipped-none + charged).
    const rows = await db.ledgerEntry.count({
      where: { userId: u.id, feature: 'file_upload_mb', bucket: dayBucket() },
    });
    expect(rows).toBe(21);
  });

  test('credits are idempotent by key', async () => {
    const u = await pastTrialUser();
    const key = `stars:t-idem-${u.id}`;
    const first = await creditWallet({ userId: u.id, micros: 500_000, kind: 'topup', idempotencyKey: key });
    expect(first.applied).toBe(true);
    const second = await creditWallet({ userId: u.id, micros: 500_000, kind: 'topup', idempotencyKey: key });
    expect(second.applied).toBe(false);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(500_000);
  });

  test('disabled features are free', async () => {
    const u = await pastTrialUser();
    await db.pricingRule.update({ where: { feature: 'ai_assistant' }, data: { enabled: false } });
    const r = await chargeFeature(u.id, 'ai_assistant');
    expect(r.outcome).toBe('free_quota');
    await db.pricingRule.update({ where: { feature: 'ai_assistant' }, data: { enabled: true } });
  });

  test('walletSummary reports usage today and prices', async () => {
    const u = await makeUser({ trial: true });
    await chargeFeature(u.id, 'bot_message');
    const summary = await walletSummary(u.id);
    expect(summary.freeRide.mode).toBe('trial');
    expect(summary.usageToday.find((x: { feature: string }) => x.feature === 'bot_message')?.used).toBe(1);
    expect(summary.prices.length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Metered sender
// ---------------------------------------------------------------------------

describe('metered sender', () => {
  test('free-ride sends pass through untouched', async () => {
    const u = await makeUser({ trial: true });
    const spy = { sends: [] as string[] };
    const sender = meteredSender(fakeSender(spy), { ownerId: u.id, botId: 'b1', feature: 'bot_message' });
    await sender.sendMessage(42, 'hello');
    expect(spy.sends).toEqual(['42:hello']);
  });

  test('out of credits → send blocked, onSkip fires once', async () => {
    const u = await pastTrialUser();
    const spy = { sends: [] as string[] };
    const skips: number[] = [];
    const sender = meteredSender(fakeSender(spy), {
      ownerId: u.id,
      botId: 'b1',
      feature: 'broadcast_message', // free tier: 0/day → immediately billable
      onSkip: () => skips.push(1),
    });
    await sender.sendMessage(42, 'nope');
    await sender.sendMessage(42, 'nope again');
    expect(spy.sends).toEqual([]);
    expect(skips.length).toBe(1);
  });

  test('billing outage fails open (send proceeds)', async () => {
    const u = await pastTrialUser();
    await db.user.delete({ where: { id: u.id } }); // chargeFeature will throw
    const spy = { sends: [] as string[] };
    const sender = meteredSender(fakeSender(spy), { ownerId: u.id, botId: 'b1', feature: 'bot_message' });
    await sender.sendMessage(7, 'still delivered');
    expect(spy.sends).toEqual(['7:still delivered']);
  });
});

// ---------------------------------------------------------------------------
// Tasks engine enforcement
// ---------------------------------------------------------------------------

describe('broadcast + schedule billing enforcement', () => {
  test('broadcast stops honestly when the owner is out of credits', async () => {
    const u = await pastTrialUser();
    const { botId, store } = await makeBot(u.id);
    await db.botUserState.create({ data: { botId, chatId: '100', attributes: '{}' } });
    await store.createBroadcast(botId, 'hi everyone', 1);
    const result = await runDueBotWork(store);
    expect(result.broadcastSent).toBe(0);
    const broadcasts = await store.listBroadcasts(botId);
    expect(broadcasts[0]?.status).toBe('done');
    expect(broadcasts[0]?.lastError).toContain('out of credits');
  });

  test('scheduled send fails honestly instead of silently skipping', async () => {
    const u = await pastTrialUser();
    const { botId, store } = await makeBot(u.id);
    // bot_message has 500 free/day — zero it for this test so the charge skips.
    await db.pricingRule.update({ where: { feature: 'bot_message' }, data: { freeDailyUnits: 0 } });
    try {
      await store.createSchedule({ botId, chatId: '200', text: 'ping', runAt: new Date(Date.now() - 1000) });
      const result = await runDueBotWork(store);
      expect(result.schedulesFailed).toBe(1);
      const schedules = await store.listSchedules(botId);
      expect(schedules[0]?.status).toBe('failed');
      expect(schedules[0]?.lastError).toContain('Out of credits');
    } finally {
      await db.pricingRule.update({ where: { feature: 'bot_message' }, data: { freeDailyUnits: 500 } });
    }
  });

  test('broadcast with credits pays per recipient', async () => {
    const u = await pastTrialUser();
    await creditWallet({ userId: u.id, micros: 1_000_000, kind: 'topup' });
    const { botId, store } = await makeBot(u.id);
    await db.botUserState.create({ data: { botId, chatId: '300', attributes: '{}' } });
    await db.botUserState.create({ data: { botId, chatId: '301', attributes: '{}' } });
    await store.createBroadcast(botId, 'paid hi', 2);
    const result = await runDueBotWork(store);
    expect(result.broadcastSent).toBe(2);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(1_000_000 - 2 * 100); // 2 × broadcast_message
  });
});

// ---------------------------------------------------------------------------
// Stars topups
// ---------------------------------------------------------------------------

describe('stars topups', () => {
  test('createStarsTopup refuses when the platform bot has no token', async () => {
    const u = await makeUser({ verified: true });
    await expect(createStarsTopup(u.id, 100)).rejects.toBeInstanceOf(TopupError);
  });

  test('successful payment credits the wallet once — duplicates are no-ops', async () => {
    const u = await pastTrialUser();
    const orderNo = `TST${counter}`;
    await db.topupOrder.create({
      data: { orderNo, userId: u.id, provider: 'stars', expectedStars: 100, expectedUsdMicros: 100 * starsRateMicros(), status: 'pending' },
    });
    const first = await completeStarsTopup(orderNo, { chargeId: `chg-${orderNo}`, stars: 100 });
    expect(first.credited).toBe(true);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(100 * starsRateMicros());
    // Telegram redelivers the same update → no double credit.
    const second = await completeStarsTopup(orderNo, { chargeId: `chg-${orderNo}`, stars: 100 });
    expect(second.credited).toBe(false);
    const after = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(after?.balanceMicros).toBe(100 * starsRateMicros());
    const order = await db.topupOrder.findUnique({ where: { orderNo } });
    expect(order?.status).toBe('paid');
    expect(order?.creditedMicros).toBe(100 * starsRateMicros());
  });
});

// ---------------------------------------------------------------------------
// Crypto topups (manual + auto)
// ---------------------------------------------------------------------------

describe('crypto topups', () => {
  test('manual flow: address → tx hash → admin approval credits the wallet', async () => {
    process.env.NURAE_CRYPTO_ADDRESS_TON = 'UQAmc4test-address-for-nurae-billing-tests-000000000';
    const u = await makeUser({ verified: true });
    const order = await createCryptoTopup(u.id, 'TON', 2_000_000);
    expect(order.address).toContain('UQAmc4');
    expect(order.status).toBe('pending');

    const withTx = await submitCryptoTx(u.id, order.id, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
    expect(withTx.status).toBe('awaiting_confirmation');

    const approved = await approveTopup(order.id);
    expect(approved.status).toBe('paid');
    expect(approved.creditedMicros).toBe(2_000_000);
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(2_000_000);
    // Approving twice never double-credits.
    await approveTopup(order.id);
    const after = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(after?.balanceMicros).toBe(2_000_000);
  });

  test('unconfigured assets are refused; admins can reject', async () => {
    const u = await makeUser({ verified: true });
    await expect(createCryptoTopup(u.id, 'ETH', 1_000_000)).rejects.toBeInstanceOf(TopupError);
    process.env.NURAE_CRYPTO_ADDRESS_LTC = 'ltc1q-test-address-for-nurae-billing-0000000';
    const order = await createCryptoTopup(u.id, 'LTC', 1_000_000);
    const rejected = await rejectTopup(order.id, 'wrong amount');
    expect(rejected.status).toBe('rejected');
    const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(0);
    delete process.env.NURAE_CRYPTO_ADDRESS_LTC;
  });

  test('auto path: CryptoBot invoices credit via the poller', async () => {
    const u = await makeUser({ verified: true });
    process.env.NURAE_CRYPTOBOT_API_TOKEN = 'test-token';
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/createInvoice')) {
        return new Response(
          JSON.stringify({ ok: true, result: { invoice_id: 4242, status: 'active', bot_invoice_url: 'https://t.me/CryptoBot?start=4242' } }),
          { status: 200 },
        );
      }
      if (url.includes('/getInvoices')) {
        return new Response(
          JSON.stringify({ ok: true, result: { items: [{ invoice_id: 4242, status: 'paid' }] } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }) as typeof fetch;

    try {
      const order = await createCryptoTopup(u.id, 'USDT', 1_000_000);
      expect(order.payUrl).toContain('CryptoBot');
      const stored0 = await db.topupOrder.findUnique({ where: { orderNo: order.orderNo } });
      expect(stored0?.providerRef).toBe('4242');
      const poll = await pollCryptoTopups();
      expect(poll.credited).toBeGreaterThanOrEqual(1);
      const balance = await db.user.findUnique({ where: { id: u.id }, select: { balanceMicros: true } });
      expect(balance?.balanceMicros).toBe(1_000_000);
      const stored = await db.topupOrder.findUnique({ where: { orderNo: order.orderNo } });
      expect(stored?.status).toBe('paid');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NURAE_CRYPTOBOT_API_TOKEN;
    }
  });

  test('poller is a no-op without the token', async () => {
    const poll = await pollCryptoTopups();
    expect(poll).toEqual({ checked: 0, credited: 0 });
  });
});

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

describe('hosting day billing', () => {
  test('trial hosting is free; charged after; idempotent per day', async () => {
    const trialUser = await makeUser({ trial: true });
    const t = await makeBot(trialUser.id);
    const r1 = await runDailyHostingBilling();
    expect(r1.free).toBeGreaterThanOrEqual(1);

    const paidUser = await pastTrialUser();
    await creditWallet({ userId: paidUser.id, micros: 1_000_000, kind: 'topup' });
    const p = await makeBot(paidUser.id);
    const r2 = await runDailyHostingBilling();
    expect(r2.charged).toBeGreaterThanOrEqual(1);
    const balance = await db.user.findUnique({ where: { id: paidUser.id }, select: { balanceMicros: true } });
    expect(balance?.balanceMicros).toBe(1_000_000 - 10_000);
    // Same day again → no double charge (ledger rows for the bot today = 1).
    await runDailyHostingBilling();
    const rows = await db.ledgerEntry.count({
      where: { userId: paidUser.id, feature: 'hosting_day', bucket: dayBucket(), refId: p.botId },
    });
    expect(rows).toBe(1);
  });

  test('three distinct unpaid days stop the bot', async () => {
    const u = await pastTrialUser();
    const { botId } = await makeBot(u.id);
    // Two unpaid days already behind us.
    for (const back of [2, 1]) {
      const day = new Date(Date.now() - back * 86_400_000);
      await db.ledgerEntry.create({
        data: {
          userId: u.id,
          kind: 'usage',
          feature: 'hosting_day',
          amountMicros: 0,
          balanceAfter: 0,
          bucket: dayBucket(day),
          refId: botId,
          idempotencyKey: `host-unpaid:${botId}:${dayBucket(day)}`,
          note: 'unpaid — out of credits',
          createdAt: day,
        },
      });
    }
    const result = await runDailyHostingBilling();
    expect(result.unpaid).toBeGreaterThanOrEqual(1);
    const bot = await db.bot.findUnique({ where: { id: botId } });
    expect(bot?.status).toBe('stopped');
    expect(bot?.statusDetail).toContain('Top up in Billing');
  });
});
