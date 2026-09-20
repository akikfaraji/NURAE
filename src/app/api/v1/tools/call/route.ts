/**
 * NURAE — POST /api/v1/tools/call: one remote tool execution.
 *
 * Body: { tool: string, args?: unknown, confirm?: boolean }.
 * Auth: `Authorization: Bearer nrae_…` (AgentToken). Identity comes from the
 * token row — never from the body.
 *
 * The response is ALWAYS 200 with { ok, status, label, detail?, data?,
 * confirmRequired? } — tool failures are honest outcomes, not HTTP errors
 * (the caller is an agent; the outcome IS the answer). status 'confirm'
 * means the action waits for human approval: consequential tools never
 * execute unless the token carries allowConsequential AND the call carries
 * confirm:true. 422 for malformed envelopes, 429 when the token outruns the
 * 60 calls/min limit.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgentToken, rateLimited } from '@/lib/nurae/api/agent-auth';
import { internalError, validationError } from '@/lib/nurae/api/base';
import { rateLimit } from '@/lib/nurae/auth/rate-limit';
import { runRemoteToolCall } from '@/lib/nurae/agents/remote-call';

const BodySchema = z.object({
  tool: z.string().min(1).max(64),
  args: z.unknown().optional(),
  confirm: z.boolean().optional(),
});

const CALL_LIMIT = 60;
const CALL_WINDOW_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireAgentToken(req);
    if (!auth.ok) return auth.res;
    const token = auth.token;

    const rl = rateLimit(`agent-api:call:${token.id}`, CALL_LIMIT, CALL_WINDOW_MS);
    if (!rl.allowed) return rateLimited(rl.retryAfter);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const outcome = await runRemoteToolCall(token, parsed.data, 1);
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    return internalError(err, 'v1/tools.call');
  }
}
