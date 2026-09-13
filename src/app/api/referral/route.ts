/**
 * NURAE — /api/referral: the signed-in user's invite link + stats.
 * GET → { referral: { code, invited, qualified, rewardDaysTotal }, reward: { days, feature } }
 * The link is <origin>/?ref=<code>. Rewards qualify server-side when the
 * invited account verifies its email — nothing here is client-decided.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { REWARD_DAYS, REWARD_FEATURE, referralStats } from '@/lib/nurae/referral';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const stats = await referralStats(user.id);
    return NextResponse.json({
      referral: stats,
      reward: { days: REWARD_DAYS, feature: REWARD_FEATURE },
    });
  } catch (err) {
    return internalError(err, 'referral.get');
  }
}
