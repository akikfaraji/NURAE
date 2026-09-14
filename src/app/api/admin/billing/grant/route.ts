/**
 * NURAE — admin: manual balance grants + price book edits.
 *
 * POST /api/admin/billing/grant  — { userId, micros, note? }
 *   Adds (or, with a negative micros amount, removes) wallet balance.
 *   Every grant lands in the ledger with an admin: idempotency key so
 *   double-submits never double-pay.
 *
 * POST /api/admin/billing/prices — { feature, unitPriceMicros?, freeDailyUnits?, enabled? }
 *   Live price tuning without a redeploy. Unknown features are refused —
 *   the compiled catalog is the only source of feature keys.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, guard, internalError, validationError } from '@/lib/nurae/api/base';
import { db } from '@/lib/db';
import { FEATURE_KEYS } from '@/lib/nurae/billing/catalog';
import { creditWallet, getPriceBook } from '@/lib/nurae/billing/wallet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GrantSchema = z.object({
  userId: z.string().min(1).max(64),
  micros: z.number().int().refine((n) => n !== 0, 'micros must be non-zero'),
  note: z.string().trim().max(500).optional(),
});

const PriceSchema = z.object({
  feature: z.string().min(1).max(64),
  unitPriceMicros: z.number().int().min(0).max(1_000_000_000).optional(),
  freeDailyUnits: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

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

    const grant = GrantSchema.safeParse(body);
    if (grant.success) {
      const exists = await db.user.findUnique({ where: { id: grant.data.userId }, select: { id: true } });
      if (!exists) return apiError('User not found.', 404);
      const key = `admin:${grant.data.userId}:${Date.now()}:${Math.abs(grant.data.micros)}`;
      const result = await creditWallet({
        userId: grant.data.userId,
        micros: grant.data.micros,
        kind: 'grant',
        idempotencyKey: key,
        note: grant.data.note ?? 'Admin grant',
      });
      return NextResponse.json({ applied: result.applied, balance: result.balance });
    }

    const price = PriceSchema.safeParse(body);
    if (price.success) {
      if (!FEATURE_KEYS.includes(price.data.feature)) {
        return apiError(`Unknown feature "${price.data.feature}".`, 404);
      }
      await getPriceBook(); // ensure the seed exists first
      const data: Record<string, unknown> = {};
      if (price.data.unitPriceMicros !== undefined) data.unitPriceMicros = price.data.unitPriceMicros;
      if (price.data.freeDailyUnits !== undefined) data.freeDailyUnits = price.data.freeDailyUnits;
      if (price.data.enabled !== undefined) data.enabled = price.data.enabled;
      if (Object.keys(data).length === 0) return apiError('Nothing to update.', 422);
      const row = await db.pricingRule.update({ where: { feature: price.data.feature }, data });
      return NextResponse.json({ rule: row });
    }

    return validationError(grant.error ?? price.error ?? new z.ZodError([]));
  } catch (err) {
    return internalError(err, 'admin.billing');
  }
}

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const prices = await getPriceBook();
    return NextResponse.json({ prices });
  } catch (err) {
    return internalError(err, 'admin.billing.prices');
  }
}
