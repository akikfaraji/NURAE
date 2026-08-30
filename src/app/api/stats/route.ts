/**
 * NURAE — dashboard overview stats (spec §15).
 * GET /api/stats — projects, active bots, stopped bots, errors.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { guard, internalError } from '@/lib/nurae/api/base';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const [projects, botStatuses] = await Promise.all([
      db.project.count({ where: { status: 'active' } }),
      db.bot.groupBy({ by: ['status'], _count: { status: true } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of botStatuses) byStatus[row.status] = row._count.status;

    const stats = {
      projects,
      activeBots: (byStatus.running ?? 0) + (byStatus.starting ?? 0),
      stoppedBots: byStatus.stopped ?? 0,
      errors: byStatus.error ?? 0,
      starting: byStatus.starting ?? 0,
      stopping: byStatus.stopping ?? 0,
      totalBots: Object.values(byStatus).reduce((a, b) => a + b, 0),
    };
    return NextResponse.json({ stats });
  } catch (err) {
    return internalError(err, 'stats');
  }
}
