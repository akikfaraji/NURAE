/**
 * NURAE — current customer identity for the public site.
 * GET /api/auth/me → { user: SessionUser | null }
 * Always 200 (the landing page probes it on every load).
 */

import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/nurae/auth/sessions';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    return NextResponse.json({ user });
  } catch {
    // Never fail the probe loudly — treat as signed out.
    return NextResponse.json({ user: null });
  }
}
