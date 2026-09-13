/**
 * NURAE — public support chat status (for the landing page).
 * GET /api/support/status → { configured, botUsername?, site }
 * configured = the official bot can answer (AI key present or env fallback).
 */

import { NextResponse } from 'next/server';
import { internalError } from '@/lib/nurae/api/base';
import { officialBotStatus } from '@/lib/nurae/auth/official-bot';
import { getSiteInfo } from '@/lib/nurae/auth/settings';

export async function GET(): Promise<Response> {
  try {
    const [bot, site] = await Promise.all([officialBotStatus(), getSiteInfo()]);
    return NextResponse.json({
      configured: bot.ready,
      telegramUsername: bot.telegramUsername,
      site,
    });
  } catch (err) {
    return internalError(err, 'support/status');
  }
}
