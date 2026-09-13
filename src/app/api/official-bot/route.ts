/**
 * NURAE — official bot summary + actions (admin dashboard overview card).
 * GET  /api/official-bot           → { bot?, official, officialPrompt }
 * POST /api/official-bot           → { action: 'sync-prompt' } rebuilds the
 *                                    official bot's system prompt from the
 *                                    current site settings.
 * GET also acts as the lazy seeding entry point (idempotent).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO, validationError } from '@/lib/nurae/api/base';
import { getOfficialBot, officialBotStatus } from '@/lib/nurae/auth/official-bot';
import { getSiteInfo, officialBotPrompt } from '@/lib/nurae/auth/settings';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const status = await officialBotStatus();
    const bot = status.botId ? await db.bot.findUnique({ where: { id: status.botId } }) : null;
    const info = await getSiteInfo();
    return NextResponse.json({
      official: status,
      bot: bot ? toBotDTO(bot) : null,
      officialPrompt: officialBotPrompt(info),
    });
  } catch (err) {
    return internalError(err, 'official-bot');
  }
}

const ActionSchema = z.object({ action: z.literal('sync-prompt') });

export async function POST(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }
    const parsed = ActionSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const bot = await getOfficialBot();
    if (!bot) return apiError('The official bot is not seeded yet — reload the dashboard.', 404);
    const info = await getSiteInfo();
    const prompt = officialBotPrompt(info);
    const updated = await db.bot.update({ where: { id: bot.id }, data: { systemPrompt: prompt } });
    return NextResponse.json({
      bot: toBotDTO(updated),
      note: 'System prompt rebuilt from the current site settings.',
    });
  } catch (err) {
    return internalError(err, 'official-bot.sync-prompt');
  }
}
