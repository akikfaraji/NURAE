/**
 * NURAE — DELETE /api/admin/agent-tokens/[id]: the operator revokes any
 * AgentToken by id (platform or user scope — the admin is the platform).
 * Idempotent.
 */

import { NextResponse } from 'next/server';
import { guard, internalError, apiError } from '@/lib/nurae/api/base';
import { revokeAgentToken } from '@/lib/nurae/auth/agent-tokens';

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const revoked = await revokeAgentToken(id);
    if (!revoked) return apiError('Token not found.', 404);
    return NextResponse.json({
      ok: true,
      revokedAt: revoked.revokedAt ? revoked.revokedAt.toISOString() : null,
    });
  } catch (err) {
    return internalError(err, 'admin/agent-tokens.revoke');
  }
}
