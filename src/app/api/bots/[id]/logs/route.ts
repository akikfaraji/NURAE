/**
 * NURAE — bot logs (spec §13).
 * GET /api/bots/{id}/logs?limit=100&level=error
 * Messages are sanitized again on read (defense in depth). Secrets never appear.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';
import { sanitizeForLog } from '@/lib/nurae/sanitize';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({ where: { id }, select: { id: true } });
    if (!bot) return apiError('Bot not found', 404);

    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 200);
    const level = url.searchParams.get('level');
    const levelFilter = level && ['info', 'warn', 'error'].includes(level) ? level : undefined;

    const logs = await db.log.findMany({
      where: { botId: id, ...(levelFilter ? { level: levelFilter } : {}) },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return NextResponse.json({
      logs: logs.map((l) => ({
        id: l.id,
        botId: l.botId,
        level: l.level,
        event: l.event,
        message: sanitizeForLog(l.message),
        timestamp: l.timestamp.toISOString(),
      })),
    });
  } catch (err) {
    return internalError(err, 'bots.logs');
  }
}
