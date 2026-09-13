/**
 * NURAE — delete one customer (admin).
 * DELETE /api/admin/customers/:id
 * Cascades sessions + verification tokens and wipes the customer's web chat
 * history with the official bot. Bot rows are admin-owned and unaffected.
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

    // Remove the web chat history tied to this user before the cascade.
    const officialPointer = await db.siteSetting.findUnique({ where: { key: 'official_bot_id' } });
    if (officialPointer) {
      const conversation = await db.conversation.findUnique({
        where: { botId_chatId: { botId: officialPointer.value, chatId: `web:${user.id}` } },
      });
      if (conversation) await db.conversation.delete({ where: { id: conversation.id } });
    }

    await db.user.delete({ where: { id: user.id } }); // sessions + tokens cascade
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'admin/customers/delete');
  }
}
