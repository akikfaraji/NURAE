/**
 * NURAE — site settings (admin).
 * GET  /api/settings → { settings }
 * PUT  /api/settings { siteName?, tagline?, supportEmail?, telegramHandle?, welcomeMessage? }
 * Empty string resets a field to its default.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guard, internalError, validationError } from '@/lib/nurae/api/base';
import { getSiteInfo, saveSiteInfo } from '@/lib/nurae/auth/settings';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ settings: await getSiteInfo() });
  } catch (err) {
    return internalError(err, 'settings/get');
  }
}

const PutSchema = z.object({
  siteName: z.string().trim().max(60).optional(),
  tagline: z.string().trim().max(200).optional(),
  supportEmail: z.union([z.string().trim().toLowerCase().email().max(254), z.literal('')]).optional(),
  telegramHandle: z
    .string()
    .trim()
    .max(60)
    .regex(/^(@[A-Za-z0-9_]{3,60})?$/, 'Use the @username form')
    .optional(),
  welcomeMessage: z.string().trim().max(500).optional(),
});

export async function PUT(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  try {
    await saveSiteInfo(parsed.data);
    return NextResponse.json({ settings: await getSiteInfo() });
  } catch (err) {
    return internalError(err, 'settings/put');
  }
}
