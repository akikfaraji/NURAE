/**
 * NURAE — on-demand verification (spec §9: Telegram identity verification, §7: validate_credentials).
 * POST /api/bots/{id}/verify
 *   Verifies the stored Telegram token (getMe) and the provider credentials.
 *   Never echoes secrets — only verification verdicts.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';
import { SecretManager } from '@/lib/nurae/secrets';
import { selectProvider } from '@/lib/nurae/ai/registry';
import { TelegramAdapter } from '@/lib/nurae/telegram/adapter';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const bot = await db.bot.findUnique({ where: { id } });
    if (!bot) return apiError('Bot not found', 404);

    const telegram: { valid: boolean; detail: string; username?: string | null } = {
      valid: false,
      detail: 'Not checked',
    };
    try {
      const adapter = new TelegramAdapter({ token: SecretManager.decrypt(bot.telegramTokenRef) });
      const me = await adapter.getMe();
      telegram.valid = true;
      telegram.detail = 'Telegram identity verified.';
      telegram.username = me.username ? `@${me.username}` : null;
    } catch (err) {
      telegram.detail = err instanceof Error ? err.message : String(err);
    }

    const provider: { valid: boolean; detail: string } = { valid: false, detail: 'Not checked' };
    try {
      const selection = selectProvider(bot.provider, {
        apiKey: bot.apiKeyRef ? SecretManager.decrypt(bot.apiKeyRef) : null,
        baseUrl: bot.baseUrl,
      });
      if (selection.info.requiresKey && !selection.apiKey) {
        provider.detail = `No API key configured for provider "${selection.info.label}".`;
      } else {
        const check = await selection.provider.validateCredentials({
          model: bot.model,
          baseUrl: selection.baseUrl,
          apiKey: selection.apiKey,
        });
        provider.valid = check.valid;
        provider.detail = check.detail ?? (check.valid ? 'Valid.' : 'Invalid.');
      }
    } catch (err) {
      provider.detail = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({ telegram, provider });
  } catch (err) {
    return internalError(err, 'bots.verify');
  }
}
