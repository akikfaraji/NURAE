/**
 * NURAE — bots of a project.
 * GET  /api/projects/{id}/bots — list bots (secret-free DTOs)
 * POST /api/projects/{id}/bots — create bot (telegram token + AI config)
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO, validationError } from '@/lib/nurae/api/base';
import { createBotSchema } from '@/lib/nurae/validation';
import { SecretManager } from '@/lib/nurae/secrets';
import { sanitizeForLog } from '@/lib/nurae/sanitize';
import { providerNeedsKey } from '@/lib/nurae/ai/registry';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const project = await db.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return apiError('Project not found', 404);
    const bots = await db.bot.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ bots: bots.map(toBotDTO) });
  } catch (err) {
    return internalError(err, 'bots.list');
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const project = await db.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return apiError('Project not found', 404);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }
    const parsed = createBotSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    // Provider credential sanity: reject impossible configs early (never trust frontend).
    if (providerNeedsKey(input.provider) && !input.apiKey) {
      const info = await import('@/lib/nurae/ai/registry').then((m) => m.getProviderInfo(input.provider));
      const envVar = info?.apiKeyEnvVar;
      const hasEnvKey = envVar ? Boolean(process.env[envVar]) : false;
      if (!hasEnvKey) {
        return apiError(
          `Provider "${info?.label ?? input.provider}" requires an API key (store it on the bot or set ${envVar ?? 'the provider env var'}).`,
          422,
        );
      }
    }

    const bot = await db.bot.create({
      data: {
        projectId: id,
        name: input.name,
        description: input.description,
        // Secrets are encrypted at rest; plaintext never touches the DB.
        telegramTokenRef: SecretManager.encrypt(input.telegramToken),
        apiKeyRef: input.apiKey ? SecretManager.encrypt(input.apiKey) : null,
        baseUrl: input.baseUrl || null,
        systemPrompt: input.systemPrompt,
        provider: input.provider,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        memorySize: input.memorySize,
        status: 'stopped',
      },
    });

    await db.log.create({
      data: {
        botId: bot.id,
        level: 'info',
        event: 'BOT_CREATED',
        message: sanitizeForLog(`Bot "${input.name}" created (provider: ${input.provider}, model: ${input.model}).`),
      },
    });

    return NextResponse.json({ bot: toBotDTO(bot) }, { status: 201 });
  } catch (err) {
    return internalError(err, 'bots.create');
  }
}
