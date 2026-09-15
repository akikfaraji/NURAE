/**
 * NURAE — GET /api/admin/bots: EVERY bot on the platform with its owner.
 * The admin monitor surface: official fleet and customer bots side by side,
 * with status, transport, audience size and message volume. Secrets never
 * appear. Stop/start/restart for any of these already exist at
 * /api/bots/[id]/stop|start|restart (admin-token guarded).
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guard, internalError } from '@/lib/nurae/api/base';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const bots = await db.bot.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        ownerId: true,
        projectId: true,
        status: true,
        statusDetail: true,
        transport: true,
        telegramUsername: true,
        archived: true,
        enabled: true,
        lastStartedAt: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { name: true } },
        _count: { select: { conversations: true, logs: true } },
      },
    });

    // Owner identities for customer bots (ownerId null = platform-owned).
    const ownerIds = [...new Set(bots.map((b) => b.ownerId).filter((v): v is string => Boolean(v)))];
    const owners = await db.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, email: true, name: true },
    });
    const ownerById = new Map(owners.map((u) => [u.id, u]));

    // Message volume per bot (grouped; avoids N queries).
    const convIds = bots.map((b) => b.id);
    const msgCounts = new Map<string, number>();
    if (convIds.length) {
      const convs = await db.conversation.findMany({
        where: { botId: { in: convIds } },
        select: { botId: true, _count: { select: { messages: true } } },
      });
      for (const c of convs) {
        msgCounts.set(c.botId, (msgCounts.get(c.botId) ?? 0) + c._count.messages);
      }
    }

    const rows = bots.map((b) => {
      const owner = b.ownerId ? ownerById.get(b.ownerId) : null;
      return {
        id: b.id,
        name: b.name,
        owner: owner
          ? { id: owner.id, email: owner.email, name: owner.name, kind: 'customer' as const }
          : { id: null, email: null, name: 'NURAE Official', kind: 'platform' as const },
        status: b.status,
        statusDetail: b.statusDetail,
        transport: b.transport,
        telegramUsername: b.telegramUsername,
        archived: b.archived,
        enabled: b.enabled,
        audience: b._count.conversations,
        messages: msgCounts.get(b.id) ?? 0,
        logs: b._count.logs,
        lastStartedAt: b.lastStartedAt?.toISOString() ?? null,
        updatedAt: b.updatedAt.toISOString(),
      };
    });

    return NextResponse.json({ bots: rows, total: rows.length });
  } catch (err) {
    return internalError(err, 'admin/bots');
  }
}
