/**
 * NURAE — admin: topup order review.
 *
 * GET  /api/admin/billing/orders?status=awaiting_confirmation — the queue.
 * POST /api/admin/billing/orders — { orderId, action: 'approve' | 'reject', note? }.
 * Approving credits the buyer's wallet (idempotent per order); rejecting
 * closes it without credit. Guarded by NURAE_ADMIN_TOKEN (open on localhost).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, guard, internalError, validationError } from '@/lib/nurae/api/base';
import { TopupError, approveTopup, listTopupOrders, rejectTopup } from '@/lib/nurae/billing/topups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orderId: z.string().min(1).max(64),
  action: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? undefined;
    const orders = await listTopupOrders({ status, limit: 100 });
    return NextResponse.json({ orders });
  } catch (err) {
    return internalError(err, 'admin.billing.orders');
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Expected a JSON body.', 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const order =
      parsed.data.action === 'approve'
        ? await approveTopup(parsed.data.orderId, parsed.data.note)
        : await rejectTopup(parsed.data.orderId, parsed.data.note);
    return NextResponse.json({ order });
  } catch (err) {
    if (err instanceof TopupError) return apiError(err.message, err.status);
    return internalError(err, 'admin.billing.orders.post');
  }
}
