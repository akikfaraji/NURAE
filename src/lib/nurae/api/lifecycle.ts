/**
 * NURAE — bot lifecycle API helper (start / stop / restart).
 * Shared by the three POST routes; proxies to the isolated runtime process.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO } from './base';
import { runtimeClient } from './runtime-client';

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

    if (action === 'start' && !bot.enabled) {
      return apiError('Bot is disabled. Enable it in configuration before starting.', 400);
    }

    const result =
      action === 'start'
        ? await runtimeClient.start(botId)
        : action === 'stop'
          ? await runtimeClient.stop(botId)
          : await runtimeClient.restart(botId);

    if (!result.ok || !result.data) {
      if (result.status === 503) {
        return apiError(
          'NURAE runtime service is not reachable. Ensure the runtime process is running.',
          503,
        );
      }
      const message = (result.data as { error?: string } | null)?.error ?? 'Runtime rejected the request.';
      return apiError(message, result.status === 404 ? 404 : 400);
    }

    const updated = await db.bot.findUnique({ where: { id: botId } });
    return NextResponse.json({
      bot: updated ? toBotDTO(updated) : null,
      runtime: result.data,
    });
  } catch (err) {
    return internalError(err, `lifecycle.${action}`);
  }
}
