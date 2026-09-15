/**
 * NURAE — GET /api/my/dashboard: everything the user's dashboard needs in
 * one ownership-checked call: the vanity slug, their bots (with lifecycle
 * state), wallet/plan snapshot, and the most recent agent sessions.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { listUserBots } from '@/lib/nurae/bots/user-bots';
import { userSlug } from '@/lib/nurae/slug';
import { db } from '@/lib/db';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);

    const [bots, account, agentSessions] = await Promise.all([
      listUserBots(user.id),
      db.user.findUnique({
        where: { id: user.id },
        select: { balanceMicros: true, planId: true, planExpiresAt: true, trialEndsAt: true },
      }),
      db.chatSession.findMany({
        where: { userId: user.id, kind: 'agent', status: 'active' },
        orderBy: { lastMessageAt: 'desc' },
        take: 3,
        select: { id: true, title: true, lastMessageAt: true },
      }),
    ]);

    return NextResponse.json({
      slug: userSlug({ name: user.name, id: user.id }),
      user: { name: user.name, email: user.email },
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        statusDetail: b.statusDetail,
        telegramUsername: b.telegramUsername,
        ownerChatId: b.ownerChatId,
        hasTelegramToken: b.hasTelegramToken,
        updatedAt: b.updatedAt,
      })),
      wallet: {
        balanceMicros: account?.balanceMicros ?? 0,
        planId: account?.planId ?? null,
        planExpiresAt: account?.planExpiresAt?.toISOString() ?? null,
        trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
      },
      agentSessions: agentSessions.map((s) => ({
        id: s.id,
        title: s.title,
        lastMessageAt: s.lastMessageAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    return internalError(err, 'my/dashboard');
  }
}
