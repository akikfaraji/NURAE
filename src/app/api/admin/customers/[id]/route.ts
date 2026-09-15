/**
 * NURAE — delete one customer (admin).
 * DELETE /api/admin/customers/:id
 * FULL cascade (V00.09.000): the customer's bots are stopped (Telegram
 * webhook removed) and deleted, then every account-scoped row goes with the
 * user: sessions, verification tokens (schema cascade), chat sessions +
 * entries + agent steps (schema cascade), uploaded files, ledger entries,
 * topup orders, referral rows and entitlements. The web support-chat
 * conversation with the official bot is removed too. Ownerless leftovers are
 * impossible — ownerId is not a schema FK, so bots are deleted explicitly.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError } from '@/lib/nurae/api/base';

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const user = await db.user.findUnique({ where: { id } });
    if (!user) return apiError('Customer not found.', 404);

    // 1. Their bots: stop (best-effort webhook teardown) then delete.
    const bots = await db.bot.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } });
    const stopped: string[] = [];
    if (bots.length) {
      const { stopBot } = await import('@/lib/nurae/runtime/transport');
      for (const bot of bots) {
        try {
          await stopBot(bot.id);
          stopped.push(bot.name);
        } catch {
          // A bot that fails to stop (no token, transport gone) is still
          // deleted below — Telegram simply keeps no webhook for it.
        }
      }
      await db.bot.deleteMany({ where: { ownerId: user.id } }); // conversations/messages/logs cascade
    }

    // 2. Account-scoped rows without schema cascades.
    await db.chatSession.deleteMany({ where: { userId: user.id } }); // entries/steps cascade
    await db.userFile.deleteMany({ where: { userId: user.id } });
    await db.ledgerEntry.deleteMany({ where: { userId: user.id } });
    await db.topupOrder.deleteMany({ where: { userId: user.id } });
    await db.entitlement.deleteMany({ where: { userId: user.id } });
    await db.referralReward.deleteMany({ where: { OR: [{ inviterId: user.id }, { invitedUserId: user.id }] } });
    await db.referral.deleteMany({ where: { inviterId: user.id } });

    // 3. The web support-chat conversation with the official bot.
    const officialPointer = await db.siteSetting.findUnique({ where: { key: 'official_bot_id' } });
    if (officialPointer) {
      const conversation = await db.conversation.findUnique({
        where: { botId_chatId: { botId: officialPointer.value, chatId: `web:${user.id}` } },
      });
      if (conversation) await db.conversation.delete({ where: { id: conversation.id } });
    }

    await db.user.delete({ where: { id: user.id } }); // sessions + tokens cascade
    return NextResponse.json({ ok: true, botsDeleted: bots.length, botsStopped: stopped.length });
  } catch (err) {
    return internalError(err, 'admin/customers/delete');
  }
}
