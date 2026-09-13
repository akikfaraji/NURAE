/**
 * NURAE — /api/agents/sessions: agent workspaces (kind="agent").
 * GET  → list the caller's agent sessions
 * POST → create one { agent: "bot-builder", title? } — the Bot Builder is
 *        the only real agent; the list grows only when new ones actually ship.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { createSession, listSessions } from '@/lib/nurae/chat/sessions';

const CreateSchema = z.object({
  agent: z.enum(['bot-builder']).default('bot-builder'),
  title: z.string().trim().max(60).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const sessions = await listSessions(user.id, 'agent');
    return NextResponse.json({ sessions });
  } catch (err) {
    return internalError(err, 'agents.list');
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return apiError('Invalid agent payload', 422);
    const session = await createSession(user.id, {
      kind: 'agent',
      agent: parsed.data.agent,
      title: parsed.data.title ?? 'Bot build',
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return internalError(err, 'agents.create');
  }
}
