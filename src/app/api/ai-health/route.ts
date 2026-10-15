/**
 * NURAE - GET /api/ai-health. Is the platform AI key working?
 * ?refresh=1 bypasses the 60 s cache (used by the dashboard "Re-check" button).
 *
 * Auth: admin token (guard) OR any signed-in site user. The payload is
 * secret-free, and the Bot Builder agent runs on the PLATFORM key — so a
 * dead platform key degrades EVERY user's agent turns, and each of them is
 * entitled to see exactly why instead of a generic rejection.
 */

import { NextResponse } from 'next/server';
import { guard, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { getAiKeyHealth } from '@/lib/nurae/ai/key-health';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) {
    const user = await sessionUser(req);
    if (!user) return denied;
  }
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    return NextResponse.json(await getAiKeyHealth(refresh), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return internalError(err, 'ai-health');
  }
}
