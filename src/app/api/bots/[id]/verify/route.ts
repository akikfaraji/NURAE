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

/** Decrypt failures must read as an ACTION for the owner, not as raw crypto noise. */
function readableSecretError(kind: 'token' | 'API key'): string {
  return `Stored ${kind} could not be decrypted — the encryption key changed (NURAE_SECRET_KEY rotated or the database path moved). Re-enter the ${kind} in this bot's configuration; it will be re-encrypted with the current key.`;
}

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
      if (!bot.telegramTokenRef) {
        telegram.detail = 'No Telegram token stored yet — add the bot token in configuration.';
      } else {
        let token: string | null = null;
        try {
          token = SecretManager.decrypt(bot.telegramTokenRef);
        } catch {
          telegram.detail = readableSecretError('token');
        }
        if (token !== null) {
          const adapter = new TelegramAdapter({ token });
          const me = await adapter.getMe();
          telegram.valid = true;
          telegram.detail = 'Telegram identity verified.';
          telegram.username = me.username ? `@${me.username}` : null;
        }
      }
    } catch (err) {
      telegram.detail = err instanceof Error ? err.message : String(err);
    }

    const provider: { valid: boolean; detail: string } = { valid: false, detail: 'Not checked' };
    try {
      let storedApiKey: string | null = null;
      let storedKeyError: string | null = null;
      if (bot.apiKeyRef) {
        try {
          storedApiKey = SecretManager.decrypt(bot.apiKeyRef);
        } catch {
          storedKeyError = readableSecretError('API key');
        }
      }
      if (storedKeyError) {
        provider.detail = storedKeyError;
      } else {
        const selection = selectProvider(bot.provider, {
          apiKey: storedApiKey,
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
      }
    } catch (err) {
      provider.detail = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({ telegram, provider });
  } catch (err) {
    return internalError(err, 'bots.verify');
  }
}
