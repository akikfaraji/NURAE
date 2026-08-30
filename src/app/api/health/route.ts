import { NextResponse } from 'next/server';
import { NURAE_NAME, NURAE_VENDOR, NURAE_VERSION, NURAE_TAGLINE, parseFraziymVersion } from '@/lib/nurae/version';

export async function GET() {
  const parsed = parseFraziymVersion(NURAE_VERSION); // validates format at runtime
  return NextResponse.json({
    status: 'ok',
    name: NURAE_NAME,
    version: NURAE_VERSION,
    vendor: NURAE_VENDOR,
    tagline: NURAE_TAGLINE,
    versionParsed: parsed,
    time: new Date().toISOString(),
  });
}
