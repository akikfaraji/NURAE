/**
 * NURAE — POST /api/my/bots/[id]/restart: stop + start the user's bot in one
 * call. Restart is the honest "something is off" control: it re-registers the
 * Telegram webhook (new secret, current allowed_updates) and reloads the
 * compiled configuration. Ownership is session-derived.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot, userBotLifecycle } from '@/lib/nurae/bots/user-bots';
import { resolvePublicBaseUrl } from '@/lib/nurae/runtime/transport';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;

    const existing = await getUserBot(user.id, id);
    if (!existing) return apiError('Bot not found', 404);

    const base = resolvePublicBaseUrl(req);
    const result = await userBotLifecycle(user.id, id, 'restart', base);
    if (!result.ok) {
      return apiError(result.error, result.status === 404 ? 404 : 400);
    }
    const bot = await getUserBot(user.id, id);
    return NextResponse.json({ bot, runtime: { status: result.status } });
  } catch (err) {
    return internalError(err, 'my/bots.restart');
  }
}
