/**
 * NURAE — POST /api/my/bots/[id]/publish: put the bot live on Telegram.
 * DELETE on the same path = unpublish (stop). Publish is a CONSEQUENTIAL
 * action: the request must carry { confirm: true } (the UI shows an explicit
 * dialog). Ownership is session-derived; the webhook origin comes from
 * request headers / NURAE_PUBLIC_BASE_URL.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot, userBotLifecycle } from '@/lib/nurae/bots/user-bots';
import { resolvePublicBaseUrl } from '@/lib/nurae/runtime/transport';

const BodySchema = z.object({ confirm: z.boolean() });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success || !parsed.data.confirm) {
      return apiError('Publishing requires explicit confirmation (confirm: true).', 422);
    }

    const existing = await getUserBot(user.id, id);
    if (!existing) return apiError('Bot not found', 404);

    const base = resolvePublicBaseUrl(req);
    const result = await userBotLifecycle(user.id, id, 'start', base);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 400 });
    }
    const bot = await getUserBot(user.id, id);
    return NextResponse.json({ bot, runtime: { status: result.status } });
  } catch (err) {
    return internalError(err, 'my/bots.publish');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const existing = await getUserBot(user.id, id);
    if (!existing) return apiError('Bot not found', 404);
    const result = await userBotLifecycle(user.id, id, 'stop', null);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const bot = await getUserBot(user.id, id);
    return NextResponse.json({ bot, runtime: { status: result.status } });
  } catch (err) {
    return internalError(err, 'my/bots.unpublish');
  }
}
