/**
 * NURAE — provider catalog + version for the dashboard (release metadata, spec §5).
 * GET /api/catalog — { version, providers[], limits }
 */

import { NextResponse } from 'next/server';
import { guard } from '@/lib/nurae/api/base';
import { internalError } from '@/lib/nurae/api/base';
import { NURAE_NAME, NURAE_VENDOR, NURAE_VERSION, NURAE_TAGLINE } from '@/lib/nurae/version';
import { PROVIDER_CATALOG } from '@/lib/nurae/ai/registry';
import { LIMITS } from '@/lib/nurae/validation';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    return NextResponse.json({
      identity: {
        name: NURAE_NAME,
        version: NURAE_VERSION,
        vendor: NURAE_VENDOR,
        tagline: NURAE_TAGLINE,
      },
      providers: PROVIDER_CATALOG.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        requiresKey: p.requiresKey,
        requiresBaseUrl: p.requiresBaseUrl,
        defaultBaseUrl: p.defaultBaseUrl,
        defaultModel: p.defaultModel,
        models: p.models,
      })),
      limits: LIMITS,
    });
  } catch (err) {
    return internalError(err, 'catalog');
  }
}
