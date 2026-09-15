/**
 * NURAE — POST /api/my/bots/[id]/notify-test: send a test alert to the
 * owner's own Telegram chat. Ownership-checked; proves the wiring (chat id +
 * bot token) before a real order ever needs it.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { sendOwnerTestAlert } from '@/lib/nurae/bots/owner-notify';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const result = await sendOwnerTestAlert(user.id, id);
    if (!result.ok) return NextResponse.json({ error: result.error, detail: result.detail ?? null }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'my/bots.notify-test');
  }
}
