/**
 * NURAE - GET /api/ai-health (admin). Is the platform AI key working?
 * ?refresh=1 bypasses the 60 s cache (used by the dashboard "Re-check" button).
 */

import { NextResponse } from 'next/server';
import { guard, internalError } from '@/lib/nurae/api/base';
import { getAiKeyHealth } from '@/lib/nurae/ai/key-health';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    return NextResponse.json(await getAiKeyHealth(refresh), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return internalError(err, 'ai-health');
  }
}
