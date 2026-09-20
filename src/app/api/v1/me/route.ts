/**
 * NURAE — GET /api/v1/me: who is this Bearer AgentToken?
 * The first call an external agent should make. Identity comes from the
 * token row — never from the request body. Owner email is included so an
 * agent can confirm it is operating the right account; nothing secret
 * (no key material, no hashes) is ever returned.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAgentToken } from '@/lib/nurae/api/agent-auth';
import { internalError } from '@/lib/nurae/api/base';

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await requireAgentToken(req);
    if (!auth.ok) return auth.res;
    const row = auth.token;
    const owner = row.ownerId
      ? await db.user.findUnique({ where: { id: row.ownerId }, select: { email: true } })
      : null;
    return NextResponse.json({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scope: row.scope,
      allowConsequential: row.allowConsequential,
      owner: owner ? { email: owner.email } : null,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    return internalError(err, 'v1/me');
  }
}
