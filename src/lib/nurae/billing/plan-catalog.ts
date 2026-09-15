/**
 * NURAE — plan catalog (PURE DATA, client-safe).
 *
 * This file must not import server modules (the pricing page renders it in
 * the browser). Server behaviors — subscribing, expiry, hosting coverage —
 * live in billing/plans.ts, which re-exports everything from here.
 */

export type PlanId = 'free' | 'plus' | 'pro';

export interface PlanSpec {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in micro-dollars (free = 0). */
  monthlyMicros: number;
  /** Multiplier applied to EVERY feature's free daily units. */
  dailyMultiplier: number;
  /** Running bots whose hosting_day is covered (0 = billed normally). */
  includedHostingBots: number;
  perks: string[];
}

export const PLANS: PlanSpec[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Everything you need to run a real bot.',
    monthlyMicros: 0,
    dailyMultiplier: 1,
    includedHostingBots: 0,
    perks: [
      'All features, no locked gates',
      'Free daily allowance on every feature',
      'Hosting at $0.01 per bot per day',
    ],
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'For bots that are actually used.',
    monthlyMicros: 4_990_000, // $4.99
    dailyMultiplier: 3,
    includedHostingBots: 3,
    perks: [
      'Every free daily allowance ×3',
      'Hosting included for 3 running bots',
      'Perfect for 1–3 active community bots',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For fleets, agencies and heavy communities.',
    monthlyMicros: 19_990_000, // $19.99
    dailyMultiplier: 10,
    includedHostingBots: 15,
    perks: [
      'Every free daily allowance ×10',
      'Hosting included for 15 running bots',
      'Best value the moment usage is real',
    ],
  },
];

export function planSpec(id: string | null | undefined): PlanSpec {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
