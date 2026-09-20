/**
 * NURAE — /api/my/tokens: the signed-in customer's Bearer AgentTokens.
 * GET  → list (metadata only — the raw key is never stored, so it can never
 *        be shown again)
 * POST → mint one { name, allowConsequential? } — returns the RAW key
 *        exactly once. Rate limited: 10 mints/hour per user.
 * Identity comes from the session cookie — never from a body field.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { rateLimit } from '@/lib/nurae/auth/rate-limit';
import { createAgentToken, toAgentTokenDTO } from '@/lib/nurae/auth/agent-tokens';

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  allowConsequential: z.boolean().default(false),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const rows = await db.agentToken.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ tokens: rows.map(toAgentTokenDTO) });
  } catch (err) {
    return internalError(err, 'my/tokens.list');
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);

    const rl = rateLimit(`agent-token-create:${user.id}`, 10, 60 * 60 * 1000);
    if (!rl.allowed) {
      return apiError(`Too many tokens minted — try again in ${Math.ceil(rl.retryAfter / 60)} min.`, 429);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const { token, row } = await createAgentToken({
      name: parsed.data.name,
      scope: 'user',
      ownerId: user.id,
      allowConsequential: parsed.data.allowConsequential,
    });
    // The raw key travels ONCE — never persisted, never listed again.
    return NextResponse.json({ token, tokenMeta: toAgentTokenDTO(row) }, { status: 201 });
  } catch (err) {
    return internalError(err, 'my/tokens.create');
  }
}
