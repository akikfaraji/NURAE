/**
 * NURAE — /api/my/bots/[id]/broadcast: owner broadcasts (newsletters).
 *
 * GET    → recent broadcasts with delivery progress.
 * POST   → queue one broadcast to every chat that ever talked to the bot.
 *          Delivery itself runs in the task engine (paced ~20 msg/s) — the
 *          POST only validates and enqueues, it never blocks on fan-out.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot } from '@/lib/nurae/bots/user-bots';
import { createPrismaRuntimeStore } from '@/lib/nurae/runtime/store';
import { db } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    const store = createPrismaRuntimeStore(db);
    const broadcasts = await store.listBroadcasts(id);
    return NextResponse.json({
      broadcasts: broadcasts.map((b) => ({
        id: b.id,
        text: b.text,
        status: b.status,
        total: b.total,
        sent: b.sent,
        failed: b.failed,
        lastError: b.lastError,
        createdAt: b.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return internalError(err, 'my/bots.broadcast.get');
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const { id } = await ctx.params;
    const bot = await getUserBot(user.id, id);
    if (!bot) return apiError('Bot not found', 404);
    if (!bot.hasTelegramToken) {
      return apiError('This bot has no Telegram token yet — a broadcast needs a live bot.', 422);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const text = typeof (body as { text?: unknown })?.text === 'string' ? ((body as { text: string }).text).trim() : '';
    if (!text || text.length > 4000) {
      return apiError('A broadcast needs text (1–4000 chars).', 422);
    }

    const store = createPrismaRuntimeStore(db);
    const chats = await store.listChatIds(id);
    if (!chats.length) {
      return apiError('No one has talked to this bot yet — there is nobody to broadcast to.', 422);
    }
    const row = await store.createBroadcast(id, text, chats.length);
    return NextResponse.json({ broadcast: { id: row.id, status: row.status, total: row.total } });
  } catch (err) {
    return internalError(err, 'my/bots.broadcast.post');
  }
}
