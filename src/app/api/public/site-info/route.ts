/**
 * NURAE — public site info (no auth): editable site details + which auth
 * methods are configured. Drives the landing page content and button
 * visibility. Only whitelisted, non-sensitive keys are exposed.
 */

import { NextResponse } from 'next/server';
import { internalError } from '@/lib/nurae/api/base';
import { getSiteInfo } from '@/lib/nurae/auth/settings';
import { googleConfig } from '@/lib/nurae/auth/google';
import { gmailConfig } from '@/lib/nurae/auth/mailer';

export async function GET(): Promise<Response> {
  try {
    const site = await getSiteInfo();
    return NextResponse.json({
      site,
      auth: {
        googleEnabled: googleConfig() !== null,
        gmailEnabled: gmailConfig() !== null,
      },
    });
  } catch (err) {
    return internalError(err, 'public/site-info');
  }
}
