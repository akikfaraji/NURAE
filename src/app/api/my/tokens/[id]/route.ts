/**
 * NURAE — DELETE /api/my/tokens/[id]: revoke one of the signed-in user's
 * AgentTokens. Ownership-checked (a foreign id is indistinguishable from a
 * missing one). Idempotent: revoking twice stays 200.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { revokeAgentToken } from '@/lib/nurae/auth/agent-tokens';

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);
    const { id } = await ctx.params;

    const row = await db.agentToken.findUnique({ where: { id }, select: { ownerId: true } });
    if (!row || row.ownerId !== user.id) return apiError('Token not found.', 404);

    const revoked = await revokeAgentToken(id);
    return NextResponse.json({
      ok: true,
      revokedAt: revoked?.revokedAt ? revoked.revokedAt.toISOString() : null,
    });
  } catch (err) {
    return internalError(err, 'my/tokens.revoke');
  }
}
