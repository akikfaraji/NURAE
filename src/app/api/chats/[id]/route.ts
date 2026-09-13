/**
 * NURAE — /api/chats/[id]: one conversation session (ownership enforced).
 * GET    → session + entries
 * PATCH  → rename / archive / unarchive { title?, status? }
 * DELETE → delete the session and its entries
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import {
  deleteSession,
  getSessionWithEntries,
  renameSession,
  setSessionStatus,
} from '@/lib/nurae/chat/sessions';

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const data = await getSessionWithEntries(user.id, id);
    if (!data) return apiError('Chat not found', 404);
    return NextResponse.json(data);
  } catch (err) {
    return internalError(err, 'chats.get');
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return apiError('Invalid patch payload', 422);

    if (parsed.data.title !== undefined) {
      const updated = await renameSession(user.id, id, parsed.data.title);
      if (!updated) return apiError('Chat not found', 404);
    }
    if (parsed.data.status !== undefined) {
      const updated = await setSessionStatus(user.id, id, parsed.data.status);
      if (!updated) return apiError('Chat not found', 404);
    }
    const data = await getSessionWithEntries(user.id, id);
    return NextResponse.json(data ?? { ok: true });
  } catch (err) {
    return internalError(err, 'chats.patch');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const ok = await deleteSession(user.id, id);
    if (!ok) return apiError('Chat not found', 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'chats.delete');
  }
}
