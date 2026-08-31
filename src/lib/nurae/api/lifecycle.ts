/**
 * NURAE — bot lifecycle API helper (start / stop / restart).
 * Shared by the three POST routes; drives the transport layer directly.
 * Since beta-02 the bot runtime lives inside this app (webhook transport is
 * stateless; polling runs in-process), so there is no runtime service call.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO } from './base';
import { restartBot, resolvePublicBaseUrl, startBot, stopBot } from '../runtime/transport';

export type LifecycleAction = 'start' | 'stop' | 'restart';

export async function performLifecycle(
  req: Request,
  botId: string,
  action: LifecycleAction,
): Promise<NextResponse> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const bot = await db.bot.findUnique({ where: { id: botId } });
    if (!bot) return apiError('Bot not found', 404);

    const publicBaseUrl = action === 'stop' ? null : resolvePublicBaseUrl(req);
    const result =
      action === 'start'
        ? await startBot(botId, { publicBaseUrl })
        : action === 'stop'
          ? await stopBot(botId)
          : await restartBot(botId, { publicBaseUrl });

    if (!result.ok) {
      return apiError(result.detail ?? 'Lifecycle action failed.', 400);
    }

    const updated = await db.bot.findUnique({ where: { id: botId } });
    return NextResponse.json({
      bot: updated ? toBotDTO(updated) : null,
      runtime: { status: result.status, transport: updated?.transport ?? null },
    });
  } catch (err) {
    return internalError(err, `lifecycle.${action}`);
  }
}
