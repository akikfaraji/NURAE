/**
 * NURAE — bot status (spec §13).
 * GET /api/bots/{id}/status — persisted status + live runtime status.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';
import { runtimeClient } from '@/lib/nurae/api/runtime-client';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({
      where: { id },
      select: { id: true, status: true, statusDetail: true, telegramUsername: true, lastStartedAt: true, enabled: true },
    });
    if (!bot) return apiError('Bot not found', 404);

    const runtime = await runtimeClient.status(id);
    const runtimeStatus = runtime.ok && runtime.data ? runtime.data : null;

    return NextResponse.json({
      botId: bot.id,
      status: runtimeStatus ? runtimeStatus.status : bot.status,
      persistedStatus: bot.status,
      statusDetail: bot.statusDetail,
      telegramUsername: bot.telegramUsername,
      enabled: bot.enabled,
      lastStartedAt: bot.lastStartedAt ? bot.lastStartedAt.toISOString() : null,
      runtimeManaged: Boolean(runtimeStatus),
    });
  } catch (err) {
    return internalError(err, 'bots.status');
  }
}
