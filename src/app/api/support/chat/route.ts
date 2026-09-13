/**
 * NURAE — public support chat (the official NURAE CS bot on the web).
 * POST /api/support/chat { message } → { reply }
 * Requires a signed-in customer session. One turn through the SAME AI
 * pipeline the Telegram bots use (memory per user, keys stay server-side).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { supportChatTurn } from '@/lib/nurae/auth/official-bot';

const BodySchema = z.object({ message: z.string().min(1).max(2000) });

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in to chat with the NURAE support bot.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const outcome = await supportChatTurn(user.id, parsed.data.message);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.message ?? 'Chat failed', code: outcome.error },
        { status: outcome.status ?? 502 },
      );
    }
    return NextResponse.json({ reply: outcome.reply });
  } catch (err) {
    return internalError(err, 'support/chat');
  }
}
