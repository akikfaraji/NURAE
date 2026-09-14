/**
 * NURAE — GET /api/billing/ledger: the caller's wallet journal (newest first).
 * Every metered event — free, trial, premium or charged — appears here.
 */

import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { recentLedger } from '@/lib/nurae/billing/wallet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const entries = await recentLedger(user.id, Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ entries });
  } catch (err) {
    return internalError(err, 'billing.ledger');
  }
}
