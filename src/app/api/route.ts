import { NextResponse } from 'next/server';
import { NURAE_NAME, NURAE_VENDOR, NURAE_VERSION, NURAE_TAGLINE } from '@/lib/nurae/version';

export async function GET() {
  return NextResponse.json({
    name: NURAE_NAME,
    version: NURAE_VERSION,
    vendor: NURAE_VENDOR,
    tagline: NURAE_TAGLINE,
  });
}
