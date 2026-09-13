/**
 * NURAE — POST /api/chats/[id]/messages: one chat turn.
 * Body: { text, attachmentIds? } → { reply, handoff? }
 * A `handoff` response means the Bot Builder agent took the task — the UI
 * offers [Open in Agent] linking to /chats/agents?session=<id>.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { chatTurn } from '@/lib/nurae/chat/sessions';

const BodySchema = z.object({
  text: z.string().max(8000).default(''),
  attachmentIds: z.array(z.string().min(1).max(64)).max(5).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return apiError('Invalid message payload', 422);

    const result = await chatTurn({
      userId: user.id,
      sessionId: id,
      text: parsed.data.text,
      attachmentIds: parsed.data.attachmentIds,
    });
    if (result.error && !result.reply) {
      const status = /not found/i.test(result.error) ? 404 : /Too fast|rate/i.test(result.error) ? 429 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ reply: result.reply, handoff: result.handoff });
  } catch (err) {
    return internalError(err, 'chats.messages');
  }
}
