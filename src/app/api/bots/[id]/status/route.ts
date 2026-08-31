/**
 * NURAE — bot status (spec Step 8).
 * GET /api/bots/{id}/status — persisted status merged with live transport state.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';
import { getBotRuntimeStatus } from '@/lib/nurae/runtime/transport';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        statusDetail: true,
        telegramUsername: true,
        lastStartedAt: true,
        enabled: true,
        transport: true,
      },
    });
    if (!bot) return apiError('Bot not found', 404);

    const runtime = await getBotRuntimeStatus(id);

    return NextResponse.json({
      botId: bot.id,
      status: runtime.status,
      persistedStatus: bot.status,
      statusDetail: bot.statusDetail,
      telegramUsername: bot.telegramUsername,
      enabled: bot.enabled,
      transport: runtime.transport,
      pendingUpdateCount: runtime.pendingUpdateCount ?? null,
      telegramLastErrorMessage: runtime.telegramLastErrorMessage ?? null,
      lastStartedAt: bot.lastStartedAt ? bot.lastStartedAt.toISOString() : null,
      runtimeManaged: runtime.managed,
    });
  } catch (err) {
    return internalError(err, 'bots.status');
  }
}
