/**
 * NURAE — POST /api/my/bots/[id]/test: run ONE real pipeline turn against a
 * captured sender so the owner can drive their bot from the Preview console.
 *
 * Contract (BR-019/BR-020 — the route must REALLY exist; it was twice claimed
 * shipped and twice lost, so this file is also covered by a test):
 *   - Session identity only; email verification required.
 *   - Foreign bots → hard 404 (ownership via getUserBot, never client ids).
 *   - Exactly one of `text` / `callbackData` → otherwise 422.
 *   - The response body always carries `error: string | null` and the
 *     captured sends/answers — pipeline failures are data, not stack traces.
 *
 * NOTE: test turns are deliberately NOT metered — the owner probing their own
 * bot is platform diagnostics, not bot traffic.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getUserBot } from '@/lib/nurae/bots/user-bots';
import { createPrismaRuntimeStore } from '@/lib/nurae/runtime/store';
import { capturingSender, routeBotUpdate } from '@/lib/nurae/runtime/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

interface TestBody {
  text?: string;
  callbackData?: string;
  callbackQueryId?: string;
  chatId?: string;
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);

    const { id: botId } = await ctx.params;
    const bot = await getUserBot(user.id, botId);
    if (!bot) return apiError('Bot not found.', 404);

    let body: TestBody;
    try {
      body = (await req.json()) as TestBody;
    } catch {
      return apiError('Expected a JSON body.', 400);
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const callbackData = typeof body.callbackData === 'string' ? body.callbackData : '';
    if (Boolean(text) === Boolean(callbackData)) {
      return apiError('Provide exactly one of "text" or "callbackData".', 422);
    }

    const store = createPrismaRuntimeStore(db);
    const record = await store.getBot(botId);
    if (!record) return apiError('Bot not found.', 404);

    const sender = capturingSender();
    const updateId = Date.now();
    const chatId = 90_000_001;

    if (text) {
      await routeBotUpdate(record, sender, {
        update_id: updateId,
        message: {
          message_id: 1,
          from: { id: chatId, is_bot: false, first_name: 'Owner', username: 'owner' },
          chat: { id: chatId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
        },
      }, { store });
    } else {
      await routeBotUpdate(record, sender, {
        update_id: updateId,
        callback_query: {
          id: body.callbackQueryId ?? `tq-${updateId}`,
          from: { id: chatId, is_bot: false, first_name: 'Owner' },
          message: { message_id: 2, chat: { id: chatId, type: 'private' } },
          data: callbackData,
        },
      }, { store });
    }

    return NextResponse.json({
      error: null,
      sends: sender.sends,
      answers: sender.answers,
      edits: sender.edits,
    });
  } catch (err) {
    return internalError(err, 'bots.test');
  }
}
