/**
 * NURAE — POST /api/billing/topup: create a topup order.
 *
 * Body (zod-validated):
 *   { provider: 'stars',  stars: number }         → invoice link on the
 *     official bot; the wallet credits when successful_payment lands on the
 *     platform webhook with payload nurae_topup_<orderNo>.
 *   { provider: 'crypto', asset: string, usdMicros: number } → auto CryptoBot
 *     invoice when configured, otherwise a manual deposit address.
 *
 * GET → the caller's recent orders.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { TopupError, createCryptoTopup, createStarsTopup, listTopupOrders } from '@/lib/nurae/billing/topups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('stars'), stars: z.number().int().min(25).max(100_000) }),
  z.object({
    provider: z.literal('crypto'),
    asset: z.string().trim().regex(/^[A-Z0-9]{2,10}$/),
    usdMicros: z.number().int().min(100_000).max(5_000_000_000),
  }),
]);

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Expected a JSON body.', 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const order =
      parsed.data.provider === 'stars'
        ? await createStarsTopup(user.id, parsed.data.stars)
        : await createCryptoTopup(user.id, parsed.data.asset, parsed.data.usdMicros);
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof TopupError) return apiError(err.message, err.status);
    return internalError(err, 'billing.topup');
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const orders = await listTopupOrders({ userId: user.id, limit: 25 });
    return NextResponse.json({ orders });
  } catch (err) {
    return internalError(err, 'billing.topups.list');
  }
}
