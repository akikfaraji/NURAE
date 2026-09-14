/**
 * NURAE — /api/my/bots/[id]/payments: completed Telegram Stars payments.
 * Refunds stay manual this release (refundStarPayment exists in the adapter
 * for a future owner control) — the ledger is honest about that.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot } from '@/lib/nurae/bots/user-bots';
import { createPrismaRuntimeStore } from '@/lib/nurae/runtime/store';
import { db } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    const store = createPrismaRuntimeStore(db);
    const rows = await store.listPayments(id);
    const totalStars = rows.reduce((sum, r) => sum + (r.currency === 'XTR' ? r.amount : 0), 0);
    return NextResponse.json({
      totalStars,
      payments: rows.map((r) => ({
        chatId: r.chatId,
        amount: r.amount,
        currency: r.currency,
        payload: r.payload,
        title: r.title,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return internalError(err, 'my/bots.payments.get');
  }
}
