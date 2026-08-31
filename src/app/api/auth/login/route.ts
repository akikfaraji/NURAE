/**
 * NURAE — admin login for the dashboard.
 * POST /api/auth/login { token } → HttpOnly session cookie (7 days).
 * Active only when NURAE_ADMIN_TOKEN is configured.
 */

import { NextResponse } from 'next/server';
import { ADMIN_COOKIE, adminToken, safeCompare } from '@/lib/nurae/api/base';

export async function POST(req: Request): Promise<Response> {
  const expected = adminToken();
  if (!expected) {
    return NextResponse.json(
      {
        error:
          'Authentication is not configured (NURAE_ADMIN_TOKEN is unset). Admin access is open in localhost mode.',
      },
      { status: 400 },
    );
  }

  let body: { token?: string } = {};
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const presented = typeof body.token === 'string' ? body.token.trim() : '';
  // Timing-safe comparison: prevents token-extraction via response timing.
  if (!presented || !safeCompare(presented, expected)) {
    return NextResponse.json({ error: 'Invalid admin token' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.headers.append(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(presented)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`,
  );
  return res;
}
