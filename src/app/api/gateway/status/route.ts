import { NextResponse } from 'next/server';
import { handleGatewayStatus } from '@/lib/gateway/gateway';

/**
 * NURAE Gateway Link — status endpoint (frontend side).
 *
 * Safe to expose without auth: it reveals only whether a backend is linked
 * and the linked HOST (never the key, never a full URL with credentials).
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await handleGatewayStatus();
  return NextResponse.json(result.body, { status: result.status });
}
