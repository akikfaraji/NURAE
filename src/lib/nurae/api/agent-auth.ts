/**
 * NURAE — shared Bearer-AgentToken guard for the /api/v1/* remote API.
 * 401 with an honest JSON error when the key is missing, malformed,
 * unknown or revoked. Identity is ALWAYS the resolved token row.
 */

import { NextResponse } from 'next/server';
import { resolveAgentToken, type AgentTokenRowLike } from '../auth/agent-tokens';

export type AgentAuth =
  | { ok: true; token: AgentTokenRowLike }
  | { ok: false; res: NextResponse };

export async function requireAgentToken(req: Request): Promise<AgentAuth> {
  const row = await resolveAgentToken(req);
  if (!row) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'Missing or invalid Bearer AgentToken. Present `Authorization: Bearer nrae_…`.' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, token: row };
}

/** 429 for per-token rate limits (tools/call 60/min, agent/turn 20/min). */
export function rateLimited(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: `Rate limit exceeded — try again in ${retryAfter}s.` },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
