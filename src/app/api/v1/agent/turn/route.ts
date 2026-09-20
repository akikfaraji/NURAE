/**
 * NURAE — POST /api/v1/agent/turn: one full Bot Builder turn over the
 * Remote API, so an external agent like Claude can drive the same
 * build/manage loop the web UI uses.
 *
 * Body: { text: string, sessionId?: string, attachmentIds?: string[] }.
 * Auth: user-scope Bearer AgentToken (platform scope → 403 — the operator
 * agent does not build customer bots). Identity comes from the token row.
 *
 * Session derivation mirrors the web flow (src/app/api/agents/sessions +
 * its messages route): an explicit sessionId continues THAT session;
 * otherwise the owner's latest active agent session continues (one ongoing
 * build workspace), or a fresh one is created from the task text.
 * userConfirmed stays false — consequential approvals happen in the web UI,
 * where the human can see what they are approving.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAgentToken, rateLimited } from '@/lib/nurae/api/agent-auth';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { rateLimit } from '@/lib/nurae/auth/rate-limit';
import {
  ensureAgentSession,
  latestActiveAgentSession,
  runBotBuilderTurn,
} from '@/lib/nurae/agents/bot-builder';
import { resolveGrowthLinks } from '@/lib/nurae/bots/growth-links';

const BodySchema = z.object({
  text: z.string().trim().min(1).max(8000),
  sessionId: z.string().min(1).max(64).optional(),
  attachmentIds: z.array(z.string().min(1).max(64)).max(5).optional(),
});

const TURN_LIMIT = 20;
const TURN_WINDOW_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireAgentToken(req);
    if (!auth.ok) return auth.res;
    const token = auth.token;
    if (token.scope !== 'user' || !token.ownerId) {
      return apiError('Platform-scope tokens cannot drive agent turns. Mint a user-scope token.', 403);
    }

    const owner = await db.user.findUnique({ where: { id: token.ownerId } });
    if (!owner) return apiError('The token owner no longer exists.', 401);
    if (!owner.emailVerified) return apiError('Verify your email first.', 403);

    const rl = rateLimit(`agent-api:turn:${token.id}`, TURN_LIMIT, TURN_WINDOW_MS);
    if (!rl.allowed) return rateLimited(rl.retryAfter);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    // Derive or create the agent session (web flow parity).
    let sessionId: string;
    if (parsed.data.sessionId) {
      const existing = await db.chatSession.findFirst({
        where: { id: parsed.data.sessionId, userId: owner.id, kind: 'agent' },
        select: { id: true },
      });
      if (!existing) return apiError('Agent session not found', 404);
      sessionId = existing.id;
    } else {
      sessionId =
        (await latestActiveAgentSession(owner.id)) ??
        (await ensureAgentSession(owner.id, {
          agent: 'bot-builder',
          title: parsed.data.text.slice(0, 60),
        }));
    }

    const result = await runBotBuilderTurn({
      userId: owner.id,
      sessionId,
      userText: parsed.data.text,
      attachmentIds: parsed.data.attachmentIds,
      userConfirmed: false, // approvals happen in the web UI
      links: resolveGrowthLinks(req),
    });

    if (result.error && !result.reply) {
      const status = /not found/i.test(result.error) ? 404 : 400;
      return NextResponse.json(
        { sessionId, reply: '', steps: [], done: false, error: result.error },
        { status },
      );
    }

    return NextResponse.json({
      sessionId,
      reply: result.reply,
      steps: result.activity,
      needsConfirm: result.needsConfirm,
      done: !result.needsConfirm && !result.error,
      draftBotId: result.draftBotId ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return internalError(err, 'v1/agent.turn');
  }
}
