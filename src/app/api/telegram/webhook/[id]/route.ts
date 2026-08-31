/**
 * NURAE — Telegram webhook receiver (spec Steps 4, 5, 12).
 *
 * POST /api/telegram/webhook/{botId}
 *
 * Telegram POSTs every bot update here once a webhook is registered
 * (setWebhook on bot start). Security model:
 *  - The endpoint is intentionally NOT admin-authenticated (Telegram cannot
 *    hold the admin cookie); instead every bot has a per-start random secret
 *    that Telegram must echo back in the X-Telegram-Bot-Api-Secret-Token
 *    header. Mismatch → 401. Secrets are stored encrypted at rest.
 *  - Responses are generic; no stack traces and no configuration details.
 *
 * Reliability: transient storage failures return 500 so Telegram's redelivery
 * kicks in; permanent per-update failures are acknowledged (200 + ignored) so
 * Telegram does not retry forever. Duplicate updates are deduplicated per bot.
 */

import { NextResponse } from 'next/server';
import { apiError } from '@/lib/nurae/api/base';
import { ingestWebhookUpdate, verifyWebhookSecret } from '@/lib/nurae/runtime/transport';

// Serverless function limits: an AI round-trip must fit inside the invocation.
export const maxDuration = 60;
// Node.js runtime (Prisma driver adapter + node:crypto are Node-only).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const secret = req.headers.get('x-telegram-bot-api-secret-token');
    const authorized = await verifyWebhookSecret(id, secret);
    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized webhook call.' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Malformed webhook payload.', 400);
    }

    // Telegram sends ONE update object per request; accept arrays defensively.
    const updates: unknown[] = Array.isArray(body) ? body : [body];
    for (const update of updates) {
      if (!isRecord(update) || typeof update.update_id !== 'number') {
        return apiError('Malformed webhook payload.', 400);
      }
      await ingestWebhookUpdate(id, update as never);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      return apiError('Bot not found', 404);
    }
    // Distinguish transient (worth a Telegram retry) from permanent failures.
    if (/storage|database|connection|timeout|unavailable/i.test(message)) {
      return NextResponse.json({ error: 'Transient failure — retry.' }, { status: 500 });
    }
    // Permanent failure: acknowledge so Telegram stops redelivering.
    console.error(`[NURAE] webhook ${id}: ${message}`);
    return NextResponse.json({ ok: true, ignored: true });
  }
}
