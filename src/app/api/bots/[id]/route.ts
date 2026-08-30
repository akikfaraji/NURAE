/**
 * NURAE — single bot.
 * GET    /api/bots/{id} — bot detail (secret-free DTO + runtime status)
 * DELETE /api/bots/{id} — stop (if running) and delete the bot
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO } from '@/lib/nurae/api/base';
import { runtimeClient } from '@/lib/nurae/api/runtime-client';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({ where: { id } });
    if (!bot) return apiError('Bot not found', 404);

    // Live runtime status (may be unmanaged → falls back to persisted status).
    const runtime = await runtimeClient.status(id);
    const runtimeStatus = runtime.ok && runtime.data ? runtime.data : null;

    return NextResponse.json({
      bot: toBotDTO(bot),
      runtime: runtimeStatus
        ? { managed: true, status: runtimeStatus.status, startedAt: runtimeStatus.startedAt }
        : { managed: false, status: null, startedAt: null },
    });
  } catch (err) {
    return internalError(err, 'bots.detail');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!bot) return apiError('Bot not found', 404);

    if (bot.status === 'running' || bot.status === 'starting') {
      await runtimeClient.stop(id); // best-effort; deletion proceeds regardless
    }
    await db.bot.delete({ where: { id } }); // cascades conversations, messages, logs
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'bots.delete');
  }
}
