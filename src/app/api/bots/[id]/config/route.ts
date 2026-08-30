/**
 * NURAE — bot configuration.
 * PUT /api/bots/{id}/config — update any subset of the bot configuration.
 *
 * Secrets: an updated Telegram token / API key is encrypted at rest. A running
 * bot keeps its current configuration until restarted — the response states it.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO, validationError } from '@/lib/nurae/api/base';
import { updateBotConfigSchema } from '@/lib/nurae/validation';
import { SecretManager } from '@/lib/nurae/secrets';
import { sanitizeForLog } from '@/lib/nurae/sanitize';
import { providerNeedsKey } from '@/lib/nurae/ai/registry';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const existing = await db.bot.findUnique({ where: { id } });
    if (!existing) return apiError('Bot not found', 404);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }
    const parsed = updateBotConfigSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    // Provider change: ensure credentials will exist after the update.
    if (input.provider && providerNeedsKey(input.provider)) {
      const willHaveKey = Boolean(input.apiKey) || Boolean(existing.apiKeyRef);
      const info = await import('@/lib/nurae/ai/registry').then((m) => m.getProviderInfo(input.provider));
      const envVar = info?.apiKeyEnvVar;
      const hasEnvKey = envVar ? Boolean(process.env[envVar]) : false;
      if (!willHaveKey && !hasEnvKey) {
        return apiError(
          `Provider "${info?.label ?? input.provider}" requires an API key.`,
          422,
        );
      }
    }

    const data: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'systemPrompt', 'provider', 'model', 'temperature', 'maxTokens', 'memorySize', 'enabled'] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    if (input.telegramToken !== undefined) {
      data.telegramTokenRef = SecretManager.encrypt(input.telegramToken);
    }
    if (input.apiKey !== undefined) {
      data.apiKeyRef = input.apiKey ? SecretManager.encrypt(input.apiKey) : null;
    }
    if (input.baseUrl !== undefined) {
      data.baseUrl = input.baseUrl || null;
    }

    const bot = await db.bot.update({ where: { id }, data });

    await db.log.create({
      data: {
        botId: id,
        level: 'info',
        message: sanitizeForLog(`Configuration updated${Object.keys(data).length ? ` (fields: ${Object.keys(data).join(', ')})` : ''}.`),
      },
    });

    const restartNeeded =
      bot.status === 'running' || bot.status === 'starting' || bot.status === 'error';

    return NextResponse.json({
      bot: toBotDTO(bot),
      note: restartNeeded
        ? 'Configuration saved. Restart the bot for changes to take effect.'
        : 'Configuration saved.',
      restartNeeded,
    });
  } catch (err) {
    return internalError(err, 'bots.config');
  }
}
