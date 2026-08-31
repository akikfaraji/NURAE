import { NextRequest, NextResponse } from 'next/server';
import { handleGatewayRegister, handleGatewayUnregister } from '@/lib/gateway/gateway';

/**
 * NURAE Gateway Link — registration endpoint (frontend side).
 *
 * POST   {endpoint, key}  → backend announces its public origin
 * DELETE {key}            → drop the current link
 *
 * See src/lib/gateway/gateway.ts for the verification rules.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => ({}));
  const result = await handleGatewayRegister(payload);
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(req: NextRequest) {
  const payload = await req.json().catch(() => ({}));
  const result = await handleGatewayUnregister(payload);
  return NextResponse.json(result.body, { status: result.status });
}
