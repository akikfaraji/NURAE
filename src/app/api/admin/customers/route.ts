/**
 * NURAE — customer directory (admin).
 * GET /api/admin/customers → { customers: [...], total }
 * Every customer with the details the admin needs: identity, verification
 * state, signup method, chat volume, session count, last activity.
 * Secrets never appear (password hashes/tokens are not selected).
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guard, internalError } from '@/lib/nurae/api/base';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const users = await db.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        googleId: true,
        passwordHash: true,
        role: true,
        balanceMicros: true,
        planId: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { sessions: true } },
      },
    });

    // Bots per customer (ownerId is not a schema FK — group it explicitly).
    // BR-031: a lagging database (missed prisma db push) must degrade these
    // OPTIONAL enrichments to zeros instead of killing the whole directory.
    const botCounts = new Map<string, number>();
    try {
      const botGroups = await db.bot.groupBy({ by: ['ownerId'], _count: { _all: true } });
      for (const g of botGroups) {
        if (g.ownerId) botCounts.set(g.ownerId, g._count._all);
      }
    } catch (err) {
      console.error(
        `[NURAE] admin/customers: bot counts unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // Chat volume per user: conversations of the official bot keyed web:<userId>.
    const chatCounts = new Map<string, number>();
    try {
      const officialPointer = await db.siteSetting.findUnique({ where: { key: 'official_bot_id' } });
      if (officialPointer) {
        const conversations = await db.conversation.findMany({
          where: { botId: officialPointer.value, chatId: { startsWith: 'web:' } },
          select: { chatId: true, _count: { select: { messages: true } } },
        });
        for (const c of conversations) {
          chatCounts.set(c.chatId.slice(4), c._count.messages);
        }
      }
    } catch (err) {
      console.error(
        `[NURAE] admin/customers: chat volume unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const customers = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      emailVerified: u.emailVerified,
      signupMethod: u.googleId ? 'google' : 'email',
      hasPassword: Boolean(u.passwordHash),
      role: u.role,
      chatMessages: chatCounts.get(u.id) ?? 0,
      activeSessions: u._count.sessions,
      botCount: botCounts.get(u.id) ?? 0,
      balanceMicros: u.balanceMicros,
      planId: u.planId ?? null,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));

    return NextResponse.json({ customers, total: customers.length });
  } catch (err) {
    return internalError(err, 'admin/customers');
  }
}
