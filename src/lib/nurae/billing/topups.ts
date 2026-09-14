/**
 * NURAE — topups: Telegram Stars, crypto (manual + CryptoBot auto).
 *
 *   STARS   — the user picks a Star amount, NURAE creates an invoice link on
 *             the official bot (createInvoiceLink, currency XTR). The user
 *             pays inside Telegram; the successful_payment update lands on
 *             the official bot's webhook with payload `nurae_topup_<orderNo>`
 *             and completeStarsTopup() credits the wallet. Idempotent by
 *             charge id + order.
 *
 *   CRYPTO  — two paths:
 *     manual (always available): per-asset deposit addresses from env; the
 *             user submits a tx hash; an admin approves; the wallet credits.
 *     auto   (NURAE_CRYPTOBOT_API_TOKEN set): USD invoice via @CryptoBot Pay;
 *             the 60 s poller credits paid invoices. UNTESTED against the
 *             live API in this environment — the manual path is the default.
 */

import { db } from '@/lib/db';
import { randomBytes } from 'node:crypto';
import { TelegramAdapter } from '../telegram/adapter';
import { getOfficialBot } from '../auth/official-bot';
import {
  TOPUP_PAYLOAD_PREFIX,
  cryptoAddress,
  cryptoBotToken,
  parseTopupPayload,
  starsRateMicros,
} from './catalog';
import { creditWallet } from './wallet';

const CRYPTOBOT_API = 'https://pay.crypt.bot/api';

export type TopupProvider = 'stars' | 'crypto';
export type TopupStatus = 'pending' | 'awaiting_confirmation' | 'paid' | 'rejected' | 'expired';

export interface TopupOrderView {
  id: string;
  orderNo: string;
  provider: string;
  asset: string | null;
  address: string | null;
  expectedStars: number | null;
  expectedUsdMicros: number | null;
  status: TopupStatus;
  payUrl: string | null;
  txHash: string | null;
  creditedMicros: number | null;
  note: string | null;
  createdAt: string;
  paidAt: string | null;
}

function toView(row: {
  id: string; orderNo: string; provider: string; asset: string | null; address: string | null;
  expectedStars: number | null; expectedUsdMicros: number | null; status: string; payUrl: string | null;
  txHash: string | null; creditedMicros: number | null; note: string | null;
  createdAt: Date; paidAt: Date | null;
}): TopupOrderView {
  return {
    id: row.id,
    orderNo: row.orderNo,
    provider: row.provider,
    asset: row.asset,
    address: row.address,
    expectedStars: row.expectedStars,
    expectedUsdMicros: row.expectedUsdMicros,
    status: row.status as TopupStatus,
    payUrl: row.payUrl,
    txHash: row.txHash,
    creditedMicros: row.creditedMicros,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}

export function newOrderNo(): string {
  return `T${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

export class TopupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Create a Stars invoice link on the official bot and record the order. */
export async function createStarsTopup(userId: string, stars: number): Promise<TopupOrderView> {
  const amount = Math.round(stars);
  if (!Number.isFinite(amount) || amount < 25 || amount > 100_000) {
    throw new TopupError('Stars amount must be between 25 and 100,000.', 422);
  }
  const bot = await getOfficialBot();
  if (!bot || !bot.telegramTokenRef) {
    throw new TopupError('Star payments are not available yet — the platform bot has no Telegram token.', 503);
  }
  let token: string;
  try {
    const { SecretManager } = await import('../secrets');
    token = SecretManager.decrypt(bot.telegramTokenRef);
  } catch {
    throw new TopupError('Star payments are not available yet (token problem).', 503);
  }
  const orderNo = newOrderNo();
  const adapter = new TelegramAdapter({ token });
  let payUrl: string;
  try {
    payUrl = await adapter.createInvoiceLink({
      title: 'NURAE credits',
      description: 'Pay-as-you-use balance for your bots and AI.',
      payload: `${TOPUP_PAYLOAD_PREFIX}${orderNo}`,
      priceStars: amount,
    });
  } catch (err) {
    throw new TopupError(
      `Telegram rejected the invoice: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      502,
    );
  }
  const row = await db.topupOrder.create({
    data: {
      orderNo,
      userId,
      provider: 'stars',
      expectedStars: amount,
      expectedUsdMicros: amount * starsRateMicros(),
      status: 'pending',
      payUrl,
    },
  });
  return toView(row);
}

/**
 * Credit a paid Stars order (called from the successful_payment branch on
 * the official bot). Idempotent: the ledger key `stars:<orderNo>` and the
 * order status guard make duplicate Telegram deliveries harmless.
 */
export async function completeStarsTopup(
  orderNo: string,
  info: { chargeId: string; stars: number },
): Promise<{ credited: boolean; orderNo: string }> {
  const order = await db.topupOrder.findUnique({ where: { orderNo } });
  if (!order || order.provider !== 'stars') return { credited: false, orderNo };
  if (order.status === 'paid') return { credited: false, orderNo };

  const micros = Math.max(0, Math.round(info.stars)) * starsRateMicros();
  const result = await creditWallet({
    userId: order.userId,
    micros,
    kind: 'topup',
    idempotencyKey: `stars:${orderNo}`,
    note: `Telegram Stars (${info.stars}★)`,
    refId: orderNo,
  });
  await db.topupOrder.update({
    where: { id: order.id },
    data: { status: 'paid', creditedMicros: micros, paidAt: new Date() },
  });
  return { credited: result.applied, orderNo };
}

// ---------------------------------------------------------------------------
// Crypto — manual (address + tx hash + admin approval)
// ---------------------------------------------------------------------------

export async function createCryptoTopup(
  userId: string,
  asset: string,
  usdMicros: number,
): Promise<TopupOrderView> {
  const usd = Math.round(usdMicros);
  if (!Number.isFinite(usd) || usd < 100_000 || usd > 5_000_000_000) {
    throw new TopupError('Amount must be between $0.10 and $5,000.', 422);
  }
  const orderNo = newOrderNo();

  // Auto path first: a CryptoBot USD invoice needs NO deposit address (the
  // user pays in any supported asset inside Telegram). Manual fallback below.
  const botToken = cryptoBotToken();
  if (botToken) {
    try {
      const invoice = await cryptoBotCreateInvoice(botToken, {
        amountUsd: usd / 1_000_000,
        payload: orderNo,
        description: 'NURAE credits',
      });
      const row = await db.topupOrder.create({
        data: {
          orderNo,
          userId,
          provider: 'crypto',
          asset: null,
          expectedUsdMicros: usd,
          status: 'pending',
          providerRef: String(invoice.invoice_id),
          payUrl: invoice.bot_invoice_url ?? invoice.pay_url ?? null,
          address: null,
          note: 'CryptoBot invoice — credited automatically when paid.',
        },
      });
      return toView(row);
    } catch (err) {
      // Fall through to the manual path — the auto rail must never block a topup.
      console.warn('[billing] CryptoBot invoice failed, falling back to manual:', err instanceof Error ? err.message : err);
    }
  }

  const address = cryptoAddress(asset);
  if (!address) {
    throw new TopupError(`Crypto topups in ${asset} are not configured.`, 404);
  }

  const row = await db.topupOrder.create({
    data: {
      orderNo,
      userId,
      provider: 'crypto',
      asset,
      address,
      expectedUsdMicros: usd,
      status: 'pending',
      note: `Send any amount you like, then submit the transaction hash. Reference: ${orderNo}`,
    },
  });
  return toView(row);
}

/** User submits a tx hash for a manual crypto order. */
export async function submitCryptoTx(userId: string, orderId: string, txHash: string): Promise<TopupOrderView> {
  const hash = txHash.trim();
  if (hash.length < 10 || hash.length > 200) throw new TopupError('That does not look like a transaction hash.', 422);
  const order = await db.topupOrder.findFirst({ where: { id: orderId, userId } });
  if (!order) throw new TopupError('Order not found.', 404);
  if (order.provider !== 'crypto' || !order.asset) throw new TopupError('Only manual crypto orders take a transaction hash.', 422);
  if (order.status === 'paid') throw new TopupError('This order is already paid.', 409);
  if (order.status !== 'pending' && order.status !== 'awaiting_confirmation') {
    throw new TopupError(`Order is ${order.status}.`, 409);
  }
  const row = await db.topupOrder.update({
    where: { id: order.id },
    data: { status: 'awaiting_confirmation', txHash: hash },
  });
  return toView(row);
}

/** Admin approves a manual order → credit. Idempotent by `crypto:<orderNo>`. */
export async function approveTopup(orderId: string, adminNote?: string): Promise<TopupOrderView> {
  const order = await db.topupOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new TopupError('Order not found.', 404);
  if (order.status === 'paid') return toView(order);
  if (order.status !== 'awaiting_confirmation' && order.status !== 'pending') {
    throw new TopupError(`Order is ${order.status}; only pending/awaiting orders can be approved.`, 409);
  }
  const micros = order.expectedUsdMicros ?? 0;
  if (micros <= 0) throw new TopupError('Order has no expected amount to credit.', 422);
  await creditWallet({
    userId: order.userId,
    micros,
    kind: 'topup',
    idempotencyKey: `crypto:${order.orderNo}`,
    note: `${order.asset ?? 'crypto'} topup (approved manually)`,
    refId: order.orderNo,
  });
  const row = await db.topupOrder.update({
    where: { id: order.id },
    data: { status: 'paid', creditedMicros: micros, paidAt: new Date(), note: adminNote ?? order.note },
  });
  return toView(row);
}

export async function rejectTopup(orderId: string, adminNote?: string): Promise<TopupOrderView> {
  const order = await db.topupOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new TopupError('Order not found.', 404);
  if (order.status === 'paid') throw new TopupError('Order is already paid — refund instead of rejecting.', 409);
  const row = await db.topupOrder.update({
    where: { id: order.id },
    data: { status: 'rejected', note: adminNote ?? order.note },
  });
  return toView(row);
}

export async function listTopupOrders(opts?: { userId?: string; status?: string; limit?: number }): Promise<TopupOrderView[]> {
  const rows = await db.topupOrder.findMany({
    where: {
      ...(opts?.userId ? { userId: opts.userId } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts?.limit ?? 50, 1), 200),
  });
  return rows.map(toView);
}

// ---------------------------------------------------------------------------
// CryptoBot Pay API (auto rail)
// ---------------------------------------------------------------------------

interface CryptoBotInvoice {
  invoice_id: number;
  status: string;
  bot_invoice_url?: string;
  pay_url?: string;
  mini_app_invoice_url?: string;
  web_app_invoice_url?: string;
}

async function cryptoBotCreateInvoice(
  token: string,
  params: { amountUsd: number; payload: string; description: string },
): Promise<CryptoBotInvoice> {
  const res = await fetch(`${CRYPTOBOT_API}/createInvoice`, {
    method: 'POST',
    headers: { 'Crypto-Pay-API-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currency_type: 'fiat',
      fiat: 'USD',
      fiat_amount: params.amountUsd.toFixed(2),
      payload: params.payload,
      description: params.description.slice(0, 1024),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { ok?: boolean; result?: CryptoBotInvoice; error?: unknown };
  if (!res.ok || !body.ok || !body.result) {
    throw new Error(`createInvoice failed (${res.status})`);
  }
  return body.result;
}

/**
 * Poll pending CryptoBot orders and credit the paid ones. Runs on the 60 s
 * task ticker. UNTESTED against the live CryptoBot API in this environment.
 */
export async function pollCryptoTopups(): Promise<{ checked: number; credited: number }> {
  const token = cryptoBotToken();
  if (!token) return { checked: 0, credited: 0 };
  const pending = await db.topupOrder.findMany({
    where: { provider: 'crypto', providerRef: { not: null }, status: 'pending' },
    take: 50,
  });
  if (pending.length === 0) return { checked: 0, credited: 0 };

  const ids = pending.map((p) => p.providerRef).join(',');
  let items: CryptoBotInvoice[] = [];
  try {
    const res = await fetch(`${CRYPTOBOT_API}/getInvoices?invoice_ids=${encodeURIComponent(ids)}`, {
      headers: { 'Crypto-Pay-API-Token': token },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok?: boolean; result?: { items?: CryptoBotInvoice[] } };
    items = body.result?.items ?? [];
  } catch {
    return { checked: 0, credited: 0 }; // network hiccup — retry next tick
  }

  let credited = 0;
  for (const order of pending) {
    const item = items.find((i) => String(i.invoice_id) === order.providerRef);
    if (!item) continue;
    if (item.status === 'paid') {
      await creditWallet({
        userId: order.userId,
        micros: order.expectedUsdMicros ?? 0,
        kind: 'topup',
        idempotencyKey: `crypto:${order.orderNo}`,
        note: `CryptoBot invoice ${order.providerRef}`,
        refId: order.orderNo,
      });
      await db.topupOrder.update({
        where: { id: order.id },
        data: { status: 'paid', creditedMicros: order.expectedUsdMicros ?? 0, paidAt: new Date() },
      });
      credited += 1;
    } else if (item.status === 'expired' && order.createdAt.getTime() < Date.now() - 24 * 3600_000) {
      await db.topupOrder.update({ where: { id: order.id }, data: { status: 'expired' } });
    }
  }
  return { checked: pending.length, credited };
}
