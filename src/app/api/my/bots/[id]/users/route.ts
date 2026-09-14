/**
 * NURAE — /api/my/bots/[id]/users: the bot's audience (per-chat state).
 * Attributes are the collected answers / carts / arrival payloads the bot
 * remembered. The owner sees their own bot's data — that is the point of a
 * bot CRM view; chat ids are Telegram ids, never NURAE account data.
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
    const chatIds = await store.listChatIds(id);
    const users: Array<{ chatId: string; attributes: Record<string, string>; startPayload: string | null }> = [];
    for (const chatId of chatIds.slice(0, 200)) {
      const state = await store.getUserState(id, chatId);
      users.push({
        chatId,
        attributes: state?.attributes ?? {},
        startPayload: state?.startPayload ?? null,
      });
    }
    return NextResponse.json({ total: chatIds.length, users });
  } catch (err) {
    return internalError(err, 'my/bots.users.get');
  }
}
