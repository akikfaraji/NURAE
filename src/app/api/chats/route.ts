/**
 * NURAE — /api/chats: conversation sessions for the signed-in customer.
 * GET  → list sessions (both chat and agent kinds, with previews)
 * POST → create a session { kind?: "chat"|"agent", title? }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { createSession, listSessions } from '@/lib/nurae/chat/sessions';

const CreateSchema = z.object({
  kind: z.enum(['chat', 'agent']).default('chat'),
  agent: z.enum(['bot-builder']).optional(),
  title: z.string().trim().max(60).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam === 'chat' || kindParam === 'agent' ? kindParam : 'all';
    const sessions = await listSessions(user.id, kind);
    return NextResponse.json({ sessions });
  } catch (err) {
    return internalError(err, 'chats.list');
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
    if (!parsed.success) return apiError('Invalid session payload', 422);
    const session = await createSession(user.id, parsed.data);
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return internalError(err, 'chats.create');
  }
}
