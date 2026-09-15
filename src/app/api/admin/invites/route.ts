/**
 * NURAE — admin: the official Invite Bot's email funnel.
 *
 * GET  /api/admin/invites — counts by status + the 50 most recent rows.
 * POST /api/admin/invites — import contacts for the invite queue:
 *   { "emails": "a@x.com, b@y.com\n...", "confirm": true }
 *
 * CONSENT IS THE PRODUCT: this endpoint exists for the site owner to invite
 * contacts they actually have permission to email (customers, community
 * members who asked, their own lists). `confirm: true` records that claim
 * and is refused otherwise. Random/generated/scraped addresses are NOT a
 * supported use — unsolicited bulk email violates anti-spam law (CAN-SPAM,
 * GDPR), burns the Gmail sender reputation, and the queue is deliberately
 * rate-limited so it cannot be abused as a blaster. Every mail carries an
 * unsubscribe path; unsubscribes are honored forever.
 *
 * The 60-second ticker drains the queue (see email/invites.ts) — invites go
 * out slowly and stop at the daily cap. Nothing here needs the admin to be
 * near a keyboard after the import.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, guard, internalError, validationError } from '@/lib/nurae/api/base';
import { importContacts } from '@/lib/nurae/email/invites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ImportSchema = z.object({
  emails: z.union([z.string().max(200_000), z.array(z.string().max(254)).max(2_000)]),
  confirm: z.literal(true),
});

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { inviteStats } = await import('@/lib/nurae/email/invites');
    return NextResponse.json(await inviteStats());
  } catch (err) {
    return internalError(err, 'admin.invites.stats');
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Expected a JSON body.', 400);
    }
    const parsed = ImportSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const raw = parsed.data.emails;
    const list = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
    const result = await importContacts(list, { confirm: true });
    return NextResponse.json(result, { status: result.accepted > 0 ? 200 : 422 });
  } catch (err) {
    return internalError(err, 'admin.invites.import');
  }
}
