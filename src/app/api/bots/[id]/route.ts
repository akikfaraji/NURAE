/**
 * NURAE — single bot.
 * GET    /api/bots/{id} — bot detail (secret-free DTO + live runtime status)
 * DELETE /api/bots/{id} — stop (if running) and delete the bot
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO } from '@/lib/nurae/api/base';
import { getBotRuntimeStatus, stopBot } from '@/lib/nurae/runtime/transport';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({ where: { id } });
    if (!bot) return apiError('Bot not found', 404);

    // Live status merged with the persisted state (transport-aware).
    const runtime = await getBotRuntimeStatus(id);

    return NextResponse.json({
      bot: toBotDTO(bot),
      runtime: {
        managed: runtime.managed,
        status: runtime.status,
        transport: runtime.transport,
        pendingUpdateCount: runtime.pendingUpdateCount ?? null,
        startedAt: null,
      },
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
      await stopBot(id); // best-effort; deletion proceeds regardless
    }
    // NOTE: no BOT_DELETED log row — it would be cascade-deleted with the bot.
    await db.bot.delete({ where: { id } }); // cascades conversations, messages, logs
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'bots.delete');
  }
}
