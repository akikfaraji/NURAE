/**
 * NURAE — pay-as-you-use price book (compiled-in defaults).
 *
 * Money is integer micro-dollars (µ$): 1,000,000 µ$ = $1.00. Floats never
 * touch balances — every price and amount is an integer.
 *
 * The catalog below is the seed for the PricingRule table; operators can
 * adjust prices live via the admin API without a redeploy. Free daily units
 * reset at midnight UTC (the `bucket` day key on every ledger row).
 *
 * Positioning: NURAE sells usage, not subscriptions — a typical bot platform
 * charges $10–$50/month whether you use it or not; here a $1 topup covers
 * ~20,000 bot messages, and the free daily allowances mean small bots never
 * run out before money does.
 */

export const MICRO = 1_000_000;

/** Every billable feature. Keys are stable API surface — never rename. */
export interface FeatureSpec {
  /** Stable machine key (ledger + PricingRule.feature). */
  key: string;
  displayName: string;
  description: string;
  unit: string;
  unitPriceMicros: number;
  freeDailyUnits: number;
  /** Platform AI features hard-gate (API error); bot-traffic features skip silently. */
  hardGate: boolean;
}

export const DEFAULT_CATALOG: FeatureSpec[] = [
  {
    key: 'ai_reply',
    displayName: 'Bot AI reply',
    description: 'AI answers inside your Telegram bot (free when the bot uses your own provider key).',
    unit: 'reply',
    unitPriceMicros: 1_500, // $0.0015
    freeDailyUnits: 50,
    hardGate: false,
  },
  {
    key: 'ai_assistant',
    displayName: 'NURAE assistant turn',
    description: 'AI turns in the NURAE chat, support chat and handoff suggestions.',
    unit: 'turn',
    unitPriceMicros: 2_000, // $0.002
    freeDailyUnits: 25,
    hardGate: true,
  },
  {
    key: 'ai_build',
    displayName: 'Agent builder round',
    description: 'One model round of the bot-builder agent (tools included).',
    unit: 'round',
    unitPriceMicros: 5_000, // $0.005
    // A complete build turn runs create → configure → verify → report (4–7
    // rounds); 10/day bought only ~2 broken turns, 40/day buys ~6 complete
    // ones (BR-034 round: turns got honest, so they got longer).
    freeDailyUnits: 40,
    hardGate: true,
  },
  {
    key: 'bot_message',
    displayName: 'Bot message sent',
    description: 'Every Telegram message your hosted bot delivers (text, media, polls, reminders).',
    unit: 'message',
    unitPriceMicros: 50, // $0.00005 — $1 ≈ 20,000 messages
    freeDailyUnits: 500,
    hardGate: false,
  },
  {
    key: 'broadcast_message',
    displayName: 'Broadcast message',
    description: 'Per-recipient fan-out of an owner broadcast.',
    unit: 'message',
    unitPriceMicros: 100, // $0.0001
    freeDailyUnits: 0,
    hardGate: false,
  },
  {
    key: 'hosting_day',
    displayName: 'Hosted bot day',
    description: 'Daily hosting for a running bot (webhook or polling). After the free week this is the only standing cost.',
    unit: 'bot/day',
    unitPriceMicros: 10_000, // $0.01 per bot per day
    freeDailyUnits: 0,
    hardGate: false,
  },
  {
    key: 'file_upload_mb',
    displayName: 'File upload',
    description: 'Storage per MB (rounded up) for documents the AI can read.',
    unit: 'MB',
    unitPriceMicros: 2_000, // $0.002 per MB
    freeDailyUnits: 20,
    hardGate: true,
  },
];

export const FEATURE_KEYS = DEFAULT_CATALOG.map((f) => f.key);

export function featureSpec(key: string): FeatureSpec | undefined {
  return DEFAULT_CATALOG.find((f) => f.key === key);
}

/** Micro-dollar amount → "$1.5", "$0.00005" — exact, no trailing zeros. */
export function formatUsd(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const dollars = Math.abs(micros) / MICRO;
  if (dollars === 0) return '$0';
  // µ$ resolution = 6 decimals; strip trailing zeros. toFixed rounds to the
  // exact integer micro value for every amount the wallet can hold.
  const out = dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${sign}$${out}`;
}

/** UTC day key (YYYY-MM-DD) — the daily free-quota + hosting bucket. */
export function dayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Topup providers
// ---------------------------------------------------------------------------

/** Micro-dollars credited per Telegram Star (default $0.014 ≈ payout rate). */
export function starsRateMicros(): number {
  const raw = Number(process.env.NURAE_STARS_RATE_MICROS ?? '');
  return Number.isFinite(raw) && raw >= 1_000_000 ? Math.round(raw) : 14_000;
}

export const STARS_PRESETS = [50, 100, 250, 500, 1000];

export const TOPUP_PAYLOAD_PREFIX = 'nurae_topup_';

/** `nurae_topup_<orderNo>` → orderNo, or null for anything else. */
export function parseTopupPayload(payload: string): string | null {
  if (!payload.startsWith(TOPUP_PAYLOAD_PREFIX)) return null;
  const orderNo = payload.slice(TOPUP_PAYLOAD_PREFIX.length);
  return orderNo.length > 0 && orderNo.length <= 32 ? orderNo : null;
}

export interface CryptoAssetSpec {
  asset: string;
  name: string;
  network: string;
}

/** The asset menu — an asset appears in the UI only when its address is configured. */
export const CRYPTO_ASSETS: CryptoAssetSpec[] = [
  { asset: 'TON', name: 'Toncoin (Gram)', network: 'TON' },
  { asset: 'BTC', name: 'Bitcoin', network: 'Bitcoin' },
  { asset: 'USDT', name: 'Tether USD', network: 'TRC-20' },
  { asset: 'ETH', name: 'Ether', network: 'ERC-20' },
  { asset: 'LTC', name: 'Litecoin', network: 'Litecoin' },
  { asset: 'TRX', name: 'Tron', network: 'TRC-20 (native TRX)' },
];

/** Deposit address for an asset from the environment, or null. */
export function cryptoAddress(asset: string): string | null {
  const raw = process.env[`NURAE_CRYPTO_ADDRESS_${asset}`];
  return raw && raw.trim().length >= 20 ? raw.trim() : null;
}

/** Assets that actually have a deposit address configured. */
export function configuredCryptoAssets(): CryptoAssetSpec[] {
  return CRYPTO_ASSETS.filter((a) => cryptoAddress(a.asset) !== null).map((a) => ({
    ...a,
    network: process.env[`NURAE_CRYPTO_NETWORK_${a.asset}`]?.trim() || a.network,
  }));
}

/** CryptoBot (@CryptoBot Pay) auto-invoicing — optional, off without the token. */
export function cryptoBotToken(): string | null {
  const t = process.env.NURAE_CRYPTOBOT_API_TOKEN;
  return t && t.trim().length > 0 ? t.trim() : null;
}

export const TRIAL_DAYS = 7;

export function trialEndsForNewUser(now: Date = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
