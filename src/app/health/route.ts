import { NextResponse } from 'next/server';
import { NURAE_NAME, NURAE_VENDOR, NURAE_VERSION, NURAE_TAGLINE } from '@/lib/nurae/version';

/** Spec §13: GET /health returns the current NURAE version. */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    name: NURAE_NAME,
    version: NURAE_VERSION,
    vendor: NURAE_VENDOR,
    tagline: NURAE_TAGLINE,
  });
}
