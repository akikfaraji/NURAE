/**
 * NURAE — /api/my/bots/[id]: one user-owned bot (ownership enforced at the
 * query level). GET returns config; PATCH updates; DELETE removes.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { deleteUserBot, getUserBot, updateUserBot } from '@/lib/nurae/bots/user-bots';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    return NextResponse.json({ bot });
  } catch (err) {
    return internalError(err, 'my/bots.get');
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const result = await updateUserBot(user.id, id, body);
    if (result.error === 'Bot not found') return apiError('Bot not found', 404);
    if (result.error || !result.bot) {
      return NextResponse.json(
        { error: result.error ?? 'Could not update the bot', fields: result.fields },
        { status: 422 },
      );
    }
    return NextResponse.json({ bot: result.bot });
  } catch (err) {
    return internalError(err, 'my/bots.patch');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const ok = await deleteUserBot(user.id, id);
    if (!ok) return apiError('Bot not found', 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'my/bots.delete');
  }
}
