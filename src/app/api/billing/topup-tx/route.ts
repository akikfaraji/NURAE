/**
 * NURAE — POST /api/billing/topup-tx: the user submits a transaction hash for
 * a manual crypto order. Ownership is session-derived; only the order's owner
 * can submit. The order then sits in `awaiting_confirmation` for admin review.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { TopupError, submitCryptoTx } from '@/lib/nurae/billing/topups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orderId: z.string().min(1).max(64),
  txHash: z.string().trim().min(10).max(200),
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
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const order = await submitCryptoTx(user.id, parsed.data.orderId, parsed.data.txHash);
    return NextResponse.json({ order });
  } catch (err) {
    if (err instanceof TopupError) return apiError(err.message, err.status);
    return internalError(err, 'billing.topup.tx');
  }
}
