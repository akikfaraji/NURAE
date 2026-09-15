/**
 * NURAE — /api/agent/operator: the platform agent for the instance admin.
 *
 * GET   → { session, entries, needsConfirm, tools } — console bootstrap
 *         (history is durable in ChatEntry; tools = the platform registry).
 * POST  → one operator turn: { text, approve? } — `approve` is set ONLY by
 *         the explicit approval control in the admin UI; it unlocks
 *         consequential platform tools (site settings) for this turn.
 *
 * Guard: the SAME NURAE_ADMIN_TOKEN guard every dashboard endpoint uses
 * (guard(req) — HttpOnly admin cookie or Bearer). With no token configured
 * (localhost dev mode) the route is open, exactly like the rest of the
 * dashboard. ToolContext.platform is set here and nowhere else.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';
import { operatorHistory, runOperatorTurn } from '@/lib/nurae/agents/operator';
import { platformToolDescriptors } from '@/lib/nurae/agents/platform-tools';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const history = await operatorHistory();
    return NextResponse.json({ ...history, tools: platformToolDescriptors() });
  } catch (err) {
    return internalError(err, 'agent.operator.get');
  }
}

const BodySchema = z.object({
  text: z.string().max(8000).default(''),
  approve: z.boolean().default(false),
});

export async function POST(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return apiError('Invalid operator payload', 422);
    if (!parsed.data.text.trim() && !parsed.data.approve) {
      return apiError('Tell the operator what to do (or approve the pending action).', 422);
    }
    const result = await runOperatorTurn({
      userText: parsed.data.text,
      userConfirmed: parsed.data.approve,
    });
    if (result.error && !result.reply) {
      const status = /not configured|no key/i.test(result.error) ? 503 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      reply: result.reply,
      activity: result.activity,
      needsConfirm: result.needsConfirm,
    });
  } catch (err) {
    return internalError(err, 'agent.operator.post');
  }
}
