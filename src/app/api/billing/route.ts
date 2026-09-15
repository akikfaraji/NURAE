/**
 * NURAE — GET /api/billing: the signed-in user's wallet.
 *
 * Returns balance, trial/premium status, today's usage per feature, the
 * effective price book, and which topup rails are actually available
 * (Stars needs an official-bot token; each crypto asset needs its address).
 */

import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { getOfficialBot } from '@/lib/nurae/auth/official-bot';
import { walletSummary } from '@/lib/nurae/billing/wallet';
import {
  STARS_PRESETS,
  configuredCryptoAssets,
  cryptoBotToken,
  starsRateMicros,
} from '@/lib/nurae/billing/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);

    const summary = await walletSummary(user.id);
    const officialBot = await getOfficialBot();

    return NextResponse.json({
      balanceMicros: summary.balanceMicros,
      freeRide: {
        mode: summary.freeRide.mode,
        trialEndsAt: summary.freeRide.trialEndsAt?.toISOString() ?? null,
        premiumEndsAt: summary.freeRide.premiumEndsAt?.toISOString() ?? null,
      },
      plan: summary.plan,
      usageToday: summary.usageToday,
      prices: summary.prices,
      topup: {
        starsAvailable: Boolean(officialBot?.telegramTokenRef),
        starsRateMicros: starsRateMicros(),
        starsPresets: STARS_PRESETS,
        cryptoAuto: Boolean(cryptoBotToken()),
        assets: configuredCryptoAssets(),
      },
    });
  } catch (err) {
    return internalError(err, 'billing.summary');
  }
}
