/**
 * NURAE — email invitations: the consent-first invite funnel.
 *
 * The official NURAE Invite Bot collects email addresses IN CHAT (the person
 * types their own address and confirms — a double opt-in with a timestamp),
 * sends a proper invitation over the site's Gmail SMTP, drips the queue from
 * the 60-second ticker, and sends at most ONE reminder a week later. The
 * site owner can import contacts they already have consent from via
 * POST /api/admin/invites (the `confirm: true` flag records that claim).
 *
 * What this module deliberately does NOT do: generate, guess, scrape or
 * "randomly try" email addresses. Unsolicited bulk email is illegal in most
 * jurisdictions (CAN-SPAM, GDPR, PECR), torches the Gmail sender reputation
 * in days, and converts at effectively zero — the real funnel is opt-in +
 * referral links + the fleet's community CTAs.
 *
 * Guarantees:
 *   - unsubscribed is TERMINAL — a re-opt-in is refused, forever;
 *   - every address gets exactly ONE invite and at most ONE reminder;
 *   - the queue respects NURAE_INVITE_DAILY_CAP (default 150/day — well
 *     under Gmail's 500/day sending limit) and paces itself per ticker tick;
 *   - a not-yet-configured SMTP or site URL leaves rows pending (never
 *     lost) — sends resume automatically once configuration lands.
 */

import { db } from '@/lib/db';
import { sendSiteMail, type SendResult } from '../auth/mailer';
import { growthLinksFromEnv } from '../bots/growth-links';
import { platformReferralCode } from '../auth/official-fleet';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max invites sent per UTC day (Gmail allows ~500; stay far below it). */
export function inviteDailyCap(): number {
  const raw = Number(process.env.NURAE_INVITE_DAILY_CAP ?? '');
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 450) : 150;
}

/** Max sends per 60-second ticker pass (≈720/hour ceiling; the cap binds first). */
const PER_TICK = 5;
/** Reminders: exactly one, this many days after the invite. */
export const REMINDER_AFTER_DAYS = 7;
const REMINDER_PER_RUN = 20;
/** Import batch ceiling — imports are for consented lists, not dumps. */
const IMPORT_MAX = 500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// ---------------------------------------------------------------------------
// Sender indirection (tests inject a fake; production uses Gmail SMTP)
// ---------------------------------------------------------------------------

export interface InviteMailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type InviteSender = (msg: InviteMailMessage, siteName: string) => Promise<SendResult>;

let sender: InviteSender = (msg, siteName) => sendSiteMail(msg.to, msg.subject, msg.text, msg.html, siteName);

/** Test hook — swap the transport. Pass null to restore production SMTP. */
export function __setInviteSender(fn: InviteSender | null): void {
  sender = fn ?? ((msg, siteName) => sendSiteMail(msg.to, msg.subject, msg.text, msg.html, siteName));
}

function siteIdentity(): { siteName: string; siteUrl: string } | null {
  const links = growthLinksFromEnv();
  if (!links) return null;
  const siteName = process.env.NURAE_SITE_NAME?.trim() || 'NURAE';
  return { siteName, siteUrl: links.siteUrl };
}

function inviteLink(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  return `${base}/?ref=${encodeURIComponent(platformReferralCode())}`;
}

// ---------------------------------------------------------------------------
// Mail composition
// ---------------------------------------------------------------------------

export function composeInvite(email: string, identity: { siteName: string; siteUrl: string }): InviteMailMessage {
  const link = inviteLink(identity.siteUrl);
  const subject = `Your ${identity.siteName} invitation — build a Telegram bot in minutes`;
  const text = [
    'Hi!',
    '',
    `You asked for an invitation to ${identity.siteName} — here it is:`,
    link,
    '',
    `${identity.siteName} builds and runs Telegram bots from a plain-English description:`,
    'AI answers, quizzes, giveaways, referral programs, payments, broadcasts —',
    'and the official bot fleet keeps communities growing on their own.',
    'Your first week is free, and the free daily allowances stay free forever.',
    '',
    'See you inside.',
    '',
    `— ${identity.siteName}`,
    `You are receiving this because this address was invited via ${identity.siteName}.`,
    'Got here by mistake? Ignore this email — you will not be emailed again.',
  ].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#09090b;color:#fafafa;padding:32px;border-radius:12px;max-width:520px">',
    `<h2 style="margin:0 0 8px;font-weight:600">Your ${escapeHtml(identity.siteName)} invitation</h2>`,
    '<p style="color:#a1a1aa;margin:0 0 20px">Build a real Telegram bot by describing it — AI answers, quizzes, giveaways, referrals, payments, broadcasts.</p>',
    `<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#fafafa;color:#09090b;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px">Open my invitation</a></p>`,
    `<p style="color:#a1a1aa;font-size:13px;margin:0 0 20px">or copy this link: <span style="color:#fafafa">${link}</span></p>`,
    '<p style="color:#71717a;font-size:12px;margin:0 0 4px">Your first week is free — and the free daily allowances stay free forever.</p>',
    `<p style="color:#71717a;font-size:12px;margin:16px 0 0">You are receiving this because this address was invited via ${escapeHtml(identity.siteName)}. Got here by mistake? Ignore this email — you will not be emailed again.</p>`,
    `<p style="color:#71717a;font-size:12px;margin:4px 0 0">${escapeHtml(identity.siteName)}</p>`,
    '</div>',
  ].join('\n');
  return { to: email, subject, text, html };
}

export function composeReminder(email: string, identity: { siteName: string; siteUrl: string }): InviteMailMessage {
  const msg = composeInvite(email, identity);
  return { ...msg, subject: `Still want your ${identity.siteName} invite? (last nudge)` };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export type OptInResult =
  | { ok: true; already: boolean }
  | { ok: false; reason: 'invalid_email' }
  | { ok: false; reason: 'unsubscribed' };

/**
 * Record an in-chat opt-in. The FIRST opt-in sends nothing by itself — the
 * caller sends the invite via sendInviteFor when it wants immediate delivery
 * (the pipeline does; the queue would cover it anyway).
 */
export async function recordOptIn(
  email: string,
  ctx: { chatId?: string; botId?: string } = {},
): Promise<OptInResult> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'invalid_email' };
  const existing = await db.emailInvite.findUnique({ where: { email: normalized } });
  if (existing?.status === 'unsubscribed') return { ok: false, reason: 'unsubscribed' };
  if (existing) {
    // Refresh attribution; do not resend here (sendInviteFor decides).
    await db.emailInvite.update({
      where: { id: existing.id },
      data: { chatId: ctx.chatId ?? existing.chatId, botId: ctx.botId ?? existing.botId },
    });
    return { ok: true, already: true };
  }
  await db.emailInvite.create({
    data: { email: normalized, source: 'optin', status: 'pending', chatId: ctx.chatId ?? null, botId: ctx.botId ?? null },
  });
  return { ok: true, already: false };
}

/**
 * Send the invite for one row NOW (used by the pipeline for fresh opt-ins).
 * Idempotent: rows already invited/reminded/joined never get a second mail.
 */
export async function sendInviteFor(email: string): Promise<SendResult & { skipped?: boolean }> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, detail: 'invalid email' };
  const row = await db.emailInvite.findUnique({ where: { email: normalized } });
  if (!row || row.status === 'unsubscribed') return { ok: false, detail: 'not opted in', skipped: true };
  if (row.sentAt) return { ok: true, detail: 'already invited', skipped: true };
  const identity = siteIdentity();
  if (!identity) return { ok: false, detail: 'site URL not configured — invite stays queued' };
  const result = await sender(composeInvite(normalized, identity), identity.siteName);
  if (result.ok) {
    await db.emailInvite.update({ where: { id: row.id }, data: { status: 'invited', sentAt: new Date() } });
  }
  return result;
}

/**
 * The pipeline's one-call entrypoint for an email_invite step: validate →
 * record consent → send (or leave queued). `outcome` maps 1:1 to the
 * behavior's reply texts, so the pipeline stays thin and honest.
 */
export async function optInAndInvite(
  rawEmail: string,
  ctx: { chatId?: string; botId?: string } = {},
): Promise<{ outcome: 'sent' | 'queued' | 'already' | 'invalid' | 'unsubscribed'; email: string }> {
  const normalized = normalizeEmail(rawEmail);
  if (!normalized) return { outcome: 'invalid', email: rawEmail };
  const optIn = await recordOptIn(normalized, ctx);
  if (!optIn.ok && optIn.reason === 'unsubscribed') return { outcome: 'unsubscribed', email: normalized };
  if (optIn.ok && optIn.already) {
    const row = await db.emailInvite.findUnique({ where: { email: normalized }, select: { sentAt: true, status: true } });
    if (row?.sentAt) return { outcome: 'already', email: normalized };
    // Pending re-opt-in (e.g. SMTP was down): fall through and try to send.
  }
  const result = await sendInviteFor(normalized);
  if (result.ok && !result.skipped) return { outcome: 'sent', email: normalized };
  if (result.ok && result.skipped) return { outcome: 'already', email: normalized };
  // Transport missing or a transient SMTP error — the row stays pending and
  // the ticker queue keeps trying. Never lose a consent.
  return { outcome: 'queued', email: normalized };
}

/** In-chat STOP: mark everything this chat opted in as unsubscribed (terminal). */
export async function unsubscribeByChat(chatId: string): Promise<number> {
  const rows = await db.emailInvite.findMany({ where: { chatId, status: { not: 'unsubscribed' } }, select: { id: true } });
  for (const row of rows) {
    await db.emailInvite.update({ where: { id: row.id }, data: { status: 'unsubscribed' } });
  }
  return rows.length;
}

export interface ImportResult {
  accepted: number;
  invalid: string[];
  duplicateInList: number;
  unsubscribedSkipped: number;
  refused?: 'missing_confirmation' | 'too_large';
}

/**
 * Owner import of CONSENTED contacts. Refuses without `confirm: true`,
 * caps the batch at IMPORT_MAX, strips invalid and duplicate addresses,
 * and never touches unsubscribed rows.
 */
export async function importContacts(list: string[], opts: { confirm: boolean }): Promise<ImportResult> {
  if (!opts.confirm) return { accepted: 0, invalid: [], duplicateInList: 0, unsubscribedSkipped: 0, refused: 'missing_confirmation' };
  const seen = new Set<string>();
  const invalid: string[] = [];
  let duplicateInList = 0;
  for (const raw of list) {
    const email = normalizeEmail(raw);
    if (!email) {
      if (raw.trim()) invalid.push(raw.trim().slice(0, 254));
      continue;
    }
    if (seen.has(email)) {
      duplicateInList += 1;
      continue;
    }
    seen.add(email);
    if (seen.size >= IMPORT_MAX) break;
  }
  if (seen.size === 0) return { accepted: 0, invalid, duplicateInList, unsubscribedSkipped: 0 };

  const rows = await db.emailInvite.findMany({ where: { email: { in: [...seen] } }, select: { email: true, status: true } });
  const byEmail = new Map(rows.map((r) => [r.email, r.status]));
  let unsubscribedSkipped = 0;
  let accepted = 0;
  for (const email of seen) {
    const status = byEmail.get(email);
    if (status === 'unsubscribed') {
      unsubscribedSkipped += 1;
      continue;
    }
    if (status) continue; // already in the funnel
    await db.emailInvite.create({ data: { email, source: 'import', status: 'pending' } });
    accepted += 1;
  }
  return { accepted, invalid, duplicateInList, unsubscribedSkipped };
}

// ---------------------------------------------------------------------------
// Ticker jobs
// ---------------------------------------------------------------------------

function startOfUtcDay(now: Date): Date {
  return new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

/**
 * Queue drain: send pending invites oldest-first under the daily cap.
 * Called from the 60-second ticker; every step is failure-isolated.
 */
export async function runInviteQueue(now: Date = new Date()): Promise<{ sent: number; skipped: string | null }> {
  const identity = siteIdentity();
  if (!identity) return { sent: 0, skipped: 'site URL not configured' };
  const sentToday = await db.emailInvite.count({ where: { sentAt: { gte: startOfUtcDay(now) } } });
  const remaining = inviteDailyCap() - sentToday;
  if (remaining <= 0) return { sent: 0, skipped: 'daily cap reached' };
  const batch = await db.emailInvite.findMany({
    where: { status: 'pending', sentAt: null },
    orderBy: { createdAt: 'asc' },
    take: Math.min(PER_TICK, remaining),
  });
  let sent = 0;
  for (const row of batch) {
    const result = await sender(composeInvite(row.email, identity), identity.siteName);
    if (result.ok) {
      await db.emailInvite.update({ where: { id: row.id }, data: { status: 'invited', sentAt: new Date() } });
      sent += 1;
    } else if (result.detail.includes('not configured')) {
      break; // transport gone — retry next tick
    }
  }
  return { sent, skipped: null };
}

/**
 * Weekly nudge: ONE reminder per address, only to rows invited 7+ days ago
 * that never unsubscribed. Unsubscribed/joined rows are never touched.
 */
export async function runInviteReminders(now: Date = new Date()): Promise<number> {
  const identity = siteIdentity();
  if (!identity) return 0;
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.emailInvite.findMany({
    where: { status: 'invited', sentAt: { lte: cutoff, not: null }, remindedAt: null },
    orderBy: { sentAt: 'asc' },
    take: REMINDER_PER_RUN,
  });
  let sent = 0;
  for (const row of rows) {
    const result = await sender(composeReminder(row.email, identity), identity.siteName);
    await db.emailInvite.update({
      where: { id: row.id },
      data: { status: 'reminded', remindedAt: new Date() },
    });
    if (result.ok) sent += 1;
  }
  return sent;
}

/** Stats for the admin API. */
export async function inviteStats(): Promise<Record<string, unknown>> {
  const grouped = await db.emailInvite.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<string, number> = {};
  let total = 0;
  for (const g of grouped) {
    counts[g.status] = g._count._all;
    total += g._count._all;
  }
  const recent = await db.emailInvite.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { email: true, source: true, status: true, sentAt: true, createdAt: true },
  });
  return {
    total,
    counts,
    dailyCap: inviteDailyCap(),
    smtpConfigured: Boolean(process.env.NURAE_GMAIL_USER && process.env.NURAE_GMAIL_APP_PASSWORD),
    recent: recent.map((r) => ({ ...r, email: maskInviteEmail(r.email) })),
  };
}

/** Logs never carry a full recipient address. */
function maskInviteEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
