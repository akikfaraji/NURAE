/**
 * NURAE — /api/my/bots/[id]/schedules: the bot's reminder/drip queue.
 *
 * GET    → pending + failed schedules (oldest run first).
 * DELETE ?scheduleId=… → cancel a pending schedule.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot } from '@/lib/nurae/bots/user-bots';
import { createPrismaRuntimeStore } from '@/lib/nurae/runtime/store';
import { db } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    const store = createPrismaRuntimeStore(db);
    const rows = await store.listSchedules(id);
    return NextResponse.json({
      schedules: rows.map((r) => ({
        id: r.id,
        chatId: r.chatId,
        text: r.text,
        runAt: r.runAt.toISOString(),
        recurrence: r.recurrence,
        status: r.status,
        lastError: r.lastError,
      })),
    });
  } catch (err) {
    return internalError(err, 'my/bots.schedules.get');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    const scheduleId = new URL(req.url).searchParams.get('scheduleId');
    if (!scheduleId) return apiError('scheduleId is required.', 422);
    const store = createPrismaRuntimeStore(db);
    const ok = await store.cancelSchedule(id, scheduleId);
    if (!ok) return apiError('Schedule not found (or already sent/cancelled).', 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'my/bots.schedules.delete');
  }
}
