/**
 * NURAE — POST /api/agents/sessions/[id]/messages: one Bot Builder turn.
 * Body: { text, attachmentIds?, approve?: boolean }.
 * `approve: true` is set ONLY by the explicit approval control in the UI —
 * it unlocks consequential tools (publish/unpublish) for this turn. The
 * model can never set it; the server derives identity from the session.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { runBotBuilderTurn } from '@/lib/nurae/agents/bot-builder';
import { resolveGrowthLinks } from '@/lib/nurae/bots/growth-links';

const BodySchema = z.object({
  text: z.string().max(8000).default(''),
  attachmentIds: z.array(z.string().min(1).max(64)).max(5).optional(),
  approve: z.boolean().default(false),
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
    if (!parsed.success) return apiError('Invalid agent payload', 422);
    if (!parsed.data.text.trim() && !parsed.data.approve && !(parsed.data.attachmentIds ?? []).length) {
      return apiError('Type a task for the agent (or approve the pending action).', 422);
    }

    const result = await runBotBuilderTurn({
      userId: user.id,
      sessionId: id,
      userText: parsed.data.text,
      attachmentIds: parsed.data.attachmentIds,
      userConfirmed: parsed.data.approve,
      links: resolveGrowthLinks(req),
    });
    if (result.error && !result.reply) {
      const status = /not found/i.test(result.error) ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      reply: result.reply,
      activity: result.activity,
      needsConfirm: result.needsConfirm,
      draftBotId: result.draftBotId ?? null,
      // Honest technical cause for the UI error banner (the reply itself
      // carries the human-facing message). null on a clean turn.
      error: result.error ?? null,
    });
  } catch (err) {
    return internalError(err, 'agents.messages');
  }
}
