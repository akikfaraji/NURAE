/**
 * NURAE — POST /api/billing/subscribe: buy (or extend) a plan with wallet
 * credit. Plans are additive perks on top of pay-as-you-use — see
 * billing/plans.ts. Insufficient balance returns 402 with the exact amount
 * needed so the UI can point the user at the topup panel.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { subscribeToPlan } from '@/lib/nurae/billing/plans';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SubscribeSchema = z.object({
  planId: z.enum(['plus', 'pro']),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Expected a JSON body.', 400);
    }
    const parsed = SubscribeSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const result = await subscribeToPlan(user.id, parsed.data.planId);
    if (!result.ok) {
      if (result.reason === 'unknown_plan') return apiError('Unknown plan.', 400);
      return NextResponse.json(
        {
          error: `Not enough credit — this plan costs $${(result.needed / 1_000_000).toFixed(2)} and your balance is $${(result.balanceMicros / 1_000_000).toFixed(2)}. Top up and try again.`,
          needed: result.needed,
          balanceMicros: result.balanceMicros,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({
      plan: { id: result.plan.id, name: result.plan.name },
      expiresAt: result.expiresAt.toISOString(),
      balanceMicros: result.balanceMicros,
    });
  } catch (err) {
    return internalError(err, 'billing.subscribe');
  }
}
