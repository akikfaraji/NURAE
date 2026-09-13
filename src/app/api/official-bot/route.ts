/**
 * NURAE — official bot summary (admin dashboard overview card).
 * GET /api/official-bot → { bot?, official }
 * Also acts as the lazy seeding entry point (idempotent).
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guard, internalError, toBotDTO } from '@/lib/nurae/api/base';
import { officialBotStatus } from '@/lib/nurae/auth/official-bot';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const status = await officialBotStatus();
    const bot = status.botId ? await db.bot.findUnique({ where: { id: status.botId } }) : null;
    return NextResponse.json({
      official: status,
      bot: bot ? toBotDTO(bot) : null,
    });
  } catch (err) {
    return internalError(err, 'official-bot');
  }
}
