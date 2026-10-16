/**
 * NURAE — the permanent do-not-mail list.
 *
 * ONE list, consulted by EVERY sender. A person who unsubscribes is not
 * "removed from one campaign" — they are removed from NURAE's promotional
 * mail and from the invitation funnel, forever. Three facts together make
 * that true (see campaign-types.ts, design rule 1):
 *
 *   1. the address is written to email_suppressions with reason 'unsubscribe'
 *      (the durable, cross-sender fact);
 *   2. a matching account gets User.mailOptOutAt (the signed-in account asked
 *      to stop — transactional mail such as verification codes is untouched);
 *   3. matching invite rows flip to status 'unsubscribed', and the invite
 *      queue consults this module before every send, so a suppression that
 *      lands while an invitation is already queued still wins.
 *
 * Re-adding an address that is already suppressed is a no-op that reports
 * `alreadySuppressed` — it never creates a second row, never clears anything,
 * and never resurrects an invite row. Removal is possible
 * (removeSuppression) but it is the ONLY way back, and it deliberately does
 * not clear an account-level opt-out: that was the account holder's own
 * decision, not a side effect of a list entry.
 */

import { db } from '@/lib/db';
import { maskEmail } from '../auth/mailer';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Address shape used for every comparison on this list. Deliberately local
 * (identical rule to invites.normalizeEmail) rather than imported from
 * invites.ts: invites.ts imports THIS module, and an import in the other
 * direction would form a cycle between the two subsystems.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Lowercase + validity check. Returns null for anything unmailable. */
export function normalizeMailAddress(raw: string): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** Why an address is on the list. Free-form in the schema; these are the ones we write. */
export type SuppressionReason = 'unsubscribe' | 'bounce' | 'complaint' | 'manual';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** True when this address must never receive promotional mail again. */
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeMailAddress(email);
  if (!normalized) return false;
  const row = await db.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } });
  return row !== null;
}

/**
 * The invite funnel's single question: may this address be invited at all?
 * True when it is on the suppression list OR its invite row is terminally
 * unsubscribed. Used by recordOptIn / sendInviteFor / the queue / reminders so
 * every invite path answers identically.
 */
export async function isInviteUnsubscribed(email: string): Promise<boolean> {
  const normalized = normalizeMailAddress(email);
  if (!normalized) return false;
  if (await isSuppressed(normalized)) return true;
  const row = await db.emailInvite.findUnique({ where: { email: normalized }, select: { status: true } });
  return row?.status === 'unsubscribed';
}

/** Addresses on the list, newest first. Masked — this is a display surface. */
export async function listSuppressions(
  limit = 100,
): Promise<Array<{ email: string; reason: string; note: string | null; createdAt: string }>> {
  const take = Number.isFinite(limit) ? Math.min(Math.max(Math.round(limit), 1), 500) : 100;
  const rows = await db.emailSuppression.findMany({ orderBy: { createdAt: 'desc' }, take });
  return rows.map((row) => ({
    email: maskEmail(row.email),
    reason: row.reason,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SuppressionOutcome {
  email: string;
  /** The address was already on the list — nothing changed. */
  alreadySuppressed: boolean;
  /** A matching account now carries User.mailOptOutAt. */
  userOptedOut: boolean;
  /** Invite rows retired by this call (they can never be invited again). */
  invitesRetired: number;
}

/**
 * Put an address on the list — the terminal, global stop. Idempotent: an
 * address that is already suppressed is reported, not rewritten. Also stops
 * the invite funnel: matching invite rows flip to 'unsubscribed'.
 *
 * Returns the normalized address in `email`; a caller that passed junk gets
 * `email: ''` and no write (there is nothing mailable to suppress).
 */
export async function addSuppression(email: string, reason: SuppressionReason | string, note?: string): Promise<SuppressionOutcome> {
  const normalized = normalizeMailAddress(email);
  if (!normalized) return { email: '', alreadySuppressed: false, userOptedOut: false, invitesRetired: 0 };

  const existing = await db.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } });
  let alreadySuppressed = existing !== null;
  if (!alreadySuppressed) {
    try {
      await db.emailSuppression.create({ data: { email: normalized, reason, note: note ?? null } });
    } catch (err) {
      // A concurrent insert of the same address is the only expected failure:
      // the unique constraint is what makes this list permanent. Anything else
      // is a real error and must not be silently swallowed.
      const still = await db.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } });
      if (!still) throw err;
      alreadySuppressed = true;
    }
  }

  // The account-level stop (email in a signed-in account that asked to stop).
  const user = await db.user.findUnique({ where: { email: normalized }, select: { id: true, mailOptOutAt: true } });
  let userOptedOut = false;
  if (user) {
    if (!user.mailOptOutAt) await db.user.update({ where: { id: user.id }, data: { mailOptOutAt: new Date() } });
    userOptedOut = true;
  }

  // The invite funnel: retire any row that could still be drained by the queue.
  const retired = await db.emailInvite.updateMany({
    where: { email: normalized, status: { not: 'unsubscribed' } },
    data: { status: 'unsubscribed' },
  });

  return { email: normalized, alreadySuppressed, userOptedOut, invitesRetired: retired.count };
}

/**
 * Take an address OFF the list (the operator's explicit reversal). Invite rows
 * stay unsubscribed and an account-level opt-out stays set: those were
 * separate decisions by the address owner, and only they can undo them.
 */
export async function removeSuppression(email: string): Promise<{ removed: boolean }> {
  const normalized = normalizeMailAddress(email);
  if (!normalized) return { removed: false };
  const existing = await db.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } });
  if (!existing) return { removed: false };
  await db.emailSuppression.delete({ where: { id: existing.id } });
  return { removed: true };
}

/**
 * Account-level marketing opt-out, keyed by user id (the operator tool and the
 * unsubscribe route both land here). Returns false when the user is unknown.
 */
export async function setUserMailOptOut(userId: string, optOut: boolean): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return false;
  await db.user.update({ where: { id: user.id }, data: { mailOptOutAt: optOut ? new Date() : null } });
  // Opting IN never clears a suppression row: the list is the permanent fact.
  if (optOut) await addSuppression(user.email, 'manual', 'account opted out of promotional mail');
  return true;
}

// ---------------------------------------------------------------------------
// Sending budget
// ---------------------------------------------------------------------------

/**
 * Max promotional mails per UTC day. Mirrors inviteDailyCap(): default 150,
 * hard-clamped at 450 — Gmail's ~500/day ceiling is the real limit and the
 * sender reputation is the asset being protected, not this number.
 */
export function mailDailyCap(): number {
  const raw = Number(process.env.NURAE_MAIL_DAILY_CAP ?? '');
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 450) : 150;
}
