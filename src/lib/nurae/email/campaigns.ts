/**
 * NURAE — promotional mail: the campaign engine.
 *
 * The grown-up relative of the invite funnel (lib/nurae/email/invites.ts).
 * Same shape, bigger consequences: a campaign is authored first, materialised
 * second, sent third — and the third step is the one that cannot be undone.
 *
 *   1. previewAudience(kind)  — how many accounts this rule would actually
 *      reach, and how many each exclusion removed. Sends nothing.
 *   2. createCampaign(draft)  — an authored draft. Sends nothing.
 *   3. queueCampaign(id)      — materialises ONE email_deliveries row per
 *      recipient (status 'queued', or 'skipped' with the reason). Sends
 *      nothing. The unique (campaignId, email) pair is the guard that makes
 *      this idempotent: a second call writes no second row, so no address can
 *      ever be mailed twice by one campaign.
 *   4. runCampaignQueue()     — one paced ticker pass, oldest-first, under
 *      mailDailyCap(). This is the only function in the module that sends to
 *      the audience.
 *
 * Guarantees (see campaign-types.ts for the contractual list):
 *   - the suppression list is consulted immediately before EVERY send, not
 *     only at queue time — an unsubscribe that lands while mail is queued
 *     still wins, and the row is retired instead of mailed;
 *   - a missing SMTP transport or a missing site URL leaves rows QUEUED and
 *     reports a skippedReason — nothing is lost, nothing is claimed;
 *   - a per-recipient SMTP failure is recorded with the real detail and the
 *     pass keeps going (one bad mailbox must not stop a campaign);
 *   - every composed mail carries the honest one-line reason for receiving it
 *     and a working, signed unsubscribe link;
 *   - display surfaces (list/detail/stats) mask addresses via maskEmail().
 */

import { db } from '@/lib/db';
import { gmailConfig, maskEmail, sendSiteMail, type SendResult } from '../auth/mailer';
import { growthLinksFromEnv } from '../bots/growth-links';
import {
  isAudienceKind,
  type AudienceKind,
  type AudiencePreview,
  type CampaignDetail,
  type CampaignDraft,
  type CampaignStats,
  type CampaignStatus,
  type CampaignSummary,
  type DeliveryRow,
  type QueueOutcome,
  type SkipReason,
  type TickOutcome,
} from './campaign-types';
import { isSuppressed, mailDailyCap, normalizeMailAddress } from './suppression';
import { signUnsubscribeToken } from './unsubscribe-token';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max sends per 60-second ticker pass, mirroring the invites' PER_TICK. */
const PER_TICK = 5;
/** Masked sample addresses in an audience preview. */
const SAMPLE_SIZE = 5;
/** Delivery rows returned with one campaign detail (the counts carry the rest). */
const DELIVERY_ROWS = 200;
/** Plans that count as paid (see billing/plan-catalog.ts). */
const PAID_PLANS = ['plus', 'pro'] as const;

// ---------------------------------------------------------------------------
// Sender indirection (tests inject a fake; production uses Gmail SMTP)
// ---------------------------------------------------------------------------

export interface CampaignMailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type CampaignSender = (msg: CampaignMailMessage, siteName: string) => Promise<SendResult>;

let sender: CampaignSender = (msg, siteName) => sendSiteMail(msg.to, msg.subject, msg.text, msg.html, siteName);

/** Test hook — swap the transport. Pass null to restore production SMTP. */
export function __setCampaignSender(fn: CampaignSender | null): void {
  sender = fn ?? ((msg, siteName) => sendSiteMail(msg.to, msg.subject, msg.text, msg.html, siteName));
}

function siteIdentity(): { siteName: string; siteUrl: string } | null {
  const links = growthLinksFromEnv();
  if (!links) return null;
  return { siteName: process.env.NURAE_SITE_NAME?.trim() || 'NURAE', siteUrl: links.siteUrl };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LIMITS = { name: 120, subject: 200, text: 200_000, html: 400_000 } as const;

interface ValidatedDraft {
  name: string;
  subject: string;
  text: string;
  html: string | null;
  audience: AudienceKind;
  createdBy: string;
}

function validateDraft(draft: CampaignDraft): ValidatedDraft {
  const name = (draft?.name ?? '').trim();
  const subject = (draft?.subject ?? '').trim();
  const text = draft?.text ?? '';
  const html = draft?.html === undefined || draft.html === null ? null : draft.html;
  if (!name) throw new Error('A campaign needs a name.');
  if (name.length > LIMITS.name) throw new Error(`The campaign name is too long (max ${LIMITS.name} characters).`);
  if (!subject) throw new Error('A campaign needs a subject line.');
  if (subject.length > LIMITS.subject) throw new Error(`The subject is too long (max ${LIMITS.subject} characters).`);
  if (!text.trim()) throw new Error('A campaign needs a body.');
  if (text.length > LIMITS.text) throw new Error('The campaign body is too long.');
  if (html !== null && html.length > LIMITS.html) throw new Error('The campaign HTML body is too long.');
  const audience = draft?.audience;
  if (!isAudienceKind(String(audience))) throw new Error(`Unknown audience "${String(audience)}".`);
  const createdBy = (draft?.createdBy ?? 'admin').trim() || 'admin';
  if (createdBy.length > 32) throw new Error('createdBy is too long (max 32 characters).');
  return { name, subject, text, html: html === '' ? null : html, audience, createdBy };
}

// ---------------------------------------------------------------------------
// Audience selection
// ---------------------------------------------------------------------------

interface CandidateUser {
  id: string;
  email: string;
  emailVerified: boolean;
  mailOptOutAt: Date | null;
}

const USER_FIELDS = { id: true, email: true, emailVerified: true, mailOptOutAt: true } as const;

interface AudienceRecipient {
  userId: string;
  email: string;
}

interface AudienceSelection {
  kind: AudienceKind;
  recipients: AudienceRecipient[];
  /** Deliberate non-sends, with the reason recorded per address. */
  skipped: Array<AudienceRecipient & { reason: SkipReason }>;
  excludedSuppressed: number;
  excludedOptOut: number;
  excludedUnverified: number;
}

/**
 * The candidate accounts for one audience rule. Only RULES that need account
 * state other than the email column are applied here; the verification rule
 * and both exclusion lists are applied in selectAudience so every exclusion
 * can be counted on its own.
 */
async function candidateUsers(kind: AudienceKind, now: Date): Promise<CandidateUser[]> {
  if (kind === 'bot_owners') {
    const bots = await db.bot.findMany({ where: { ownerId: { not: null } }, select: { ownerId: true } });
    const ownerIds = [...new Set(bots.map((b) => b.ownerId).filter((id): id is string => Boolean(id)))];
    if (ownerIds.length === 0) return [];
    return db.user.findMany({
      where: { id: { in: ownerIds } },
      select: USER_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }
  if (kind === 'trial_users') {
    return db.user.findMany({
      where: { trialEndsAt: { gt: now } },
      select: USER_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }
  if (kind === 'paid_users') {
    return db.user.findMany({
      where: { planId: { in: [...PAID_PLANS] }, planExpiresAt: { gt: now } },
      select: USER_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }
  // 'verified_users' and 'all_users' both start from the whole table — the
  // verification requirement is applied (and counted) in selectAudience.
  return db.user.findMany({ where: {}, select: USER_FIELDS, orderBy: { createdAt: 'asc' } });
}

/**
 * Apply the exclusion rules to the candidate set. Precedence is
 * suppressed → account opt-out → unverified, so each account is counted once
 * and the most permanent reason is the one recorded.
 */
async function selectAudience(kind: AudienceKind, now: Date = new Date()): Promise<AudienceSelection> {
  const users = await candidateUsers(kind, now);
  const suppressedRows = await db.emailSuppression.findMany({ select: { email: true } });
  const suppressed = new Set(suppressedRows.map((r) => r.email));
  const requiresVerified = kind === 'verified_users';

  const recipients: AudienceRecipient[] = [];
  const skipped: Array<AudienceRecipient & { reason: SkipReason }> = [];
  const seen = new Set<string>();
  let excludedSuppressed = 0;
  let excludedOptOut = 0;
  let excludedUnverified = 0;

  for (const user of users) {
    const email = normalizeMailAddress(user.email);
    // A stored address that does not normalize is unmailable: it is neither a
    // recipient nor a per-rule exclusion (there is no counter for "junk row").
    if (!email) continue;
    // Case-variant duplicates normalise to one mailbox; the unique
    // (campaignId, email) guard is the contract, so mail it once.
    if (seen.has(email)) continue;
    seen.add(email);
    if (suppressed.has(email)) {
      excludedSuppressed += 1;
      skipped.push({ userId: user.id, email, reason: 'unsubscribed' });
      continue;
    }
    if (user.mailOptOutAt) {
      excludedOptOut += 1;
      skipped.push({ userId: user.id, email, reason: 'opt_out' });
      continue;
    }
    if (requiresVerified && !user.emailVerified) {
      excludedUnverified += 1;
      skipped.push({ userId: user.id, email, reason: 'unverified' });
      continue;
    }
    recipients.push({ userId: user.id, email });
  }

  return { kind, recipients, skipped, excludedSuppressed, excludedOptOut, excludedUnverified };
}

/** Audience size + exclusions, computed WITHOUT sending or writing anything. */
export async function previewAudience(kind: AudienceKind): Promise<AudiencePreview> {
  if (!isAudienceKind(String(kind))) throw new Error(`Unknown audience "${String(kind)}".`);
  const selection = await selectAudience(kind);
  return {
    kind,
    recipients: selection.recipients.length,
    excludedSuppressed: selection.excludedSuppressed,
    excludedOptOut: selection.excludedOptOut,
    excludedUnverified: selection.excludedUnverified,
    sample: selection.recipients.slice(0, SAMPLE_SIZE).map((r) => maskEmail(r.email)),
  };
}

// ---------------------------------------------------------------------------
// Mail composition
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function unsubscribeUrl(siteUrl: string, email: string): string {
  const token = signUnsubscribeToken(email);
  return `${siteUrl.replace(/\/+$/, '')}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

const REASON_LINE = (siteName: string) => `You are receiving this because you have a ${siteName} account.`;

function textFooter(siteName: string, link: string): string {
  return ['', '—', REASON_LINE(siteName), `Unsubscribe from promotional email (permanent, one click): ${link}`].join('\n');
}

function htmlFooter(siteName: string, link: string): string {
  return [
    '<hr style="border:none;border-top:1px solid #27272a;margin:24px 0 12px"/>',
    `<p style="color:#71717a;font-size:12px;margin:0 0 4px">${escapeHtml(REASON_LINE(siteName))}</p>`,
    `<p style="color:#71717a;font-size:12px;margin:0"><a href="${link}" style="color:#a1a1aa">Unsubscribe from promotional email</a> — one click, permanent.</p>`,
  ].join('\n');
}

/** Derive an HTML body from the plain-text body, escaping everything. */
function deriveHtml(text: string, siteName: string, link: string): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#09090b;color:#fafafa;padding:32px;border-radius:12px;max-width:560px">',
    paragraphs,
    htmlFooter(siteName, link),
    `<p style="color:#71717a;font-size:12px;margin:8px 0 0">${escapeHtml(siteName)}</p>`,
    '</div>',
  ].join('\n');
}

/**
 * One recipient's copy of a campaign: text + html, both carrying the honest
 * reason line and the signed unsubscribe link. Throws only when no signing
 * key is configured — an unsigned unsubscribe link must never go out.
 */
export function composeCampaign(
  campaign: { subject: string; text: string; html: string | null },
  email: string,
  identity: { siteName: string; siteUrl: string },
): CampaignMailMessage {
  const link = unsubscribeUrl(identity.siteUrl, email);
  const text = `${campaign.text.trimEnd()}\n${textFooter(identity.siteName, link)}`;
  const html = campaign.html && campaign.html.trim()
    ? `${campaign.html.trimEnd()}\n${htmlFooter(identity.siteName, link)}`
    : deriveHtml(campaign.text, identity.siteName, link);
  return { to: email, subject: campaign.subject, text, html };
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

export async function createCampaign(draft: CampaignDraft): Promise<{ id: string }> {
  const valid = validateDraft(draft);
  const row = await db.emailCampaign.create({
    data: {
      name: valid.name,
      subject: valid.subject,
      text: valid.text,
      html: valid.html,
      audience: valid.audience,
      createdBy: valid.createdBy,
      status: 'draft',
    },
    select: { id: true },
  });
  return { id: row.id };
}

/**
 * Edit a DRAFT. Any other status is refused: a queued campaign's audience is
 * already materialised and a sent campaign is history — rewriting either would
 * make the delivery rows lie about what was mailed.
 */
export async function updateCampaign(id: string, patch: Partial<CampaignDraft>): Promise<CampaignSummary> {
  const existing = await db.emailCampaign.findUnique({ where: { id } });
  if (!existing) throw new Error(`Campaign ${id} not found.`);
  if (existing.status !== 'draft') {
    throw new Error(`This campaign is ${existing.status} — only drafts can be edited.`);
  }
  const merged = validateDraft({
    name: patch.name ?? existing.name,
    subject: patch.subject ?? existing.subject,
    text: patch.text ?? existing.text,
    // Prisma hands back `string | null` for a nullable column; the draft type
    // uses `string | undefined` for "no HTML body". 
    html: patch.html === undefined ? (existing.html ?? undefined) : patch.html,
    audience: (patch.audience ?? existing.audience) as AudienceKind,
    createdBy: patch.createdBy ?? existing.createdBy,
  });
  const row = await db.emailCampaign.update({
    where: { id },
    data: {
      name: merged.name,
      subject: merged.subject,
      text: merged.text,
      html: merged.html,
      audience: merged.audience,
      createdBy: merged.createdBy,
    },
  });
  return toSummary(row);
}

function toSummary(row: {
  id: string; name: string; subject: string; audience: string; status: string; createdBy: string;
  recipientCount: number; sentCount: number; failedCount: number; skippedCount: number;
  lastError: string | null; queuedAt: Date | null; completedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    audience: (isAudienceKind(row.audience) ? row.audience : 'verified_users') as AudienceKind,
    status: row.status as CampaignStatus,
    createdBy: row.createdBy,
    recipientCount: row.recipientCount,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    skippedCount: row.skippedCount,
    lastError: row.lastError,
    queuedAt: row.queuedAt ? row.queuedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCampaigns(limit = 50): Promise<CampaignSummary[]> {
  const take = Number.isFinite(limit) ? Math.min(Math.max(Math.round(limit), 1), 200) : 50;
  const rows = await db.emailCampaign.findMany({ orderBy: { createdAt: 'desc' }, take });
  return rows.map(toSummary);
}

/** One campaign with its per-recipient rows MASKED — never a raw address. */
export async function getCampaign(id: string): Promise<CampaignDetail | null> {
  const row = await db.emailCampaign.findUnique({ where: { id } });
  if (!row) return null;
  const deliveries = await db.emailDelivery.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: 'asc' },
    take: DELIVERY_ROWS,
    select: { email: true, status: true, detail: true, sentAt: true },
  });
  const rows: DeliveryRow[] = deliveries.map((d) => ({
    emailMasked: maskEmail(d.email),
    status: d.status as DeliveryRow['status'],
    detail: d.detail,
    sentAt: d.sentAt ? d.sentAt.toISOString() : null,
  }));
  return { ...toSummary(row), text: row.text, html: row.html, deliveries: rows };
}

// ---------------------------------------------------------------------------
// Test send — ONE mail, never the audience
// ---------------------------------------------------------------------------

/**
 * Send a single copy to one address so the author can see the real mail before
 * queueing it. Touches no delivery row and no audience member: the mail is a
 * sample, and the sample never counts as a send.
 */
export async function testSend(id: string, to: string): Promise<SendResult> {
  const campaign = await db.emailCampaign.findUnique({ where: { id } });
  if (!campaign) return { ok: false, detail: 'Campaign not found.' };
  const email = normalizeMailAddress(to);
  if (!email) return { ok: false, detail: 'That is not a valid email address.' };
  if (await isSuppressed(email)) {
    return { ok: false, detail: 'That address is on the do-not-mail list — nothing was sent.' };
  }
  const account = await db.user.findUnique({ where: { email }, select: { mailOptOutAt: true } });
  if (account?.mailOptOutAt) {
    return { ok: false, detail: 'That account opted out of promotional mail — nothing was sent.' };
  }
  const identity = siteIdentity();
  if (!identity) return { ok: false, detail: 'NURAE_SITE_URL is not configured — no unsubscribe link can be built.' };
  let msg: CampaignMailMessage;
  try {
    msg = composeCampaign(campaign, email, identity);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  return sender(msg, identity.siteName);
}

// ---------------------------------------------------------------------------
// Queueing — materialise, send nothing
// ---------------------------------------------------------------------------

interface DeliveryCounts {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function countDeliveries(campaignId: string): Promise<DeliveryCounts> {
  const grouped = await db.emailDelivery.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts: DeliveryCounts = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  for (const group of grouped) {
    if (group.status === 'queued' || group.status === 'sent' || group.status === 'failed' || group.status === 'skipped') {
      counts[group.status] = group._count._all;
    }
  }
  return counts;
}

/** Honest per-reason skip tallies, read back from the rows themselves. */
async function queueOutcomeFor(campaignId: string): Promise<QueueOutcome> {
  const [counts, grouped] = await Promise.all([
    countDeliveries(campaignId),
    db.emailDelivery.groupBy({ by: ['detail'], where: { campaignId, status: 'skipped' }, _count: { _all: true } }),
  ]);
  const byDetail = new Map(grouped.map((g) => [g.detail ?? '', g._count._all]));
  return {
    queued: counts.queued,
    skippedSuppressed: byDetail.get('unsubscribed') ?? 0,
    skippedOptOut: byDetail.get('opt_out') ?? 0,
    skippedUnverified: byDetail.get('unverified') ?? 0,
  };
}

/**
 * Write one row per recipient. createMany is the fast path; the per-row
 * fallback covers both an adapter without createMany and the unique
 * (campaignId, email) conflict — which on this path simply means "already
 * recorded". A fallback that wrote nothing AND left no rows behind rethrows
 * the real error instead of reporting a phantom campaign.
 */
async function createDeliveries(
  campaignId: string,
  rows: Array<{ userId: string | null; email: string; status: string; detail: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  const data = rows.map((row) => ({ campaignId, ...row }));
  try {
    await db.emailDelivery.createMany({ data });
    return;
  } catch (err) {
    let firstError: unknown = err;
    let created = 0;
    for (const row of data) {
      try {
        await db.emailDelivery.create({ data: row });
        created += 1;
      } catch (inner) {
        if (firstError === err) firstError = inner;
      }
    }
    if (created === 0) {
      const existing = await db.emailDelivery.count({ where: { campaignId } });
      if (existing === 0) throw firstError;
    }
  }
}

/**
 * Materialise a campaign's recipients: one row each, status 'queued' for the
 * people who will be mailed and 'skipped' (with 'unsubscribed' | 'opt_out' |
 * 'unverified') for the ones the rules excluded. Sends nothing.
 *
 * Idempotent by construction: a campaign that is already materialised is
 * reported as it stands and NOTHING is written — the audience is frozen the
 * moment it is queued, and no address can be added to a campaign that is
 * already going out.
 */
export async function queueCampaign(id: string): Promise<QueueOutcome> {
  const campaign = await db.emailCampaign.findUnique({ where: { id } });
  if (!campaign) throw new Error(`Campaign ${id} not found.`);
  if (campaign.status === 'sent') throw new Error('This campaign has already been sent.');
  if (campaign.status === 'cancelled') throw new Error('This campaign was cancelled.');
  if (campaign.status !== 'draft') return queueOutcomeFor(id);

  const kind = (isAudienceKind(campaign.audience) ? campaign.audience : 'verified_users') as AudienceKind;
  const selection = await selectAudience(kind);
  await createDeliveries(id, [
    ...selection.recipients.map((r) => ({ userId: r.userId, email: r.email, status: 'queued', detail: null })),
    ...selection.skipped.map((s) => ({ userId: s.userId, email: s.email, status: 'skipped', detail: s.reason })),
  ]);

  const counts = await countDeliveries(id);
  await db.emailCampaign.update({
    where: { id },
    data: {
      status: 'queued',
      queuedAt: new Date(),
      recipientCount: counts.queued + counts.sent + counts.failed,
      sentCount: counts.sent,
      failedCount: counts.failed,
      skippedCount: counts.skipped,
      lastError: null,
    },
  });

  return {
    queued: selection.recipients.length,
    skippedSuppressed: selection.excludedSuppressed,
    skippedOptOut: selection.excludedOptOut,
    skippedUnverified: selection.excludedUnverified,
  };
}

// ---------------------------------------------------------------------------
// Ticker job — the only path that mails the audience
// ---------------------------------------------------------------------------

function startOfUtcDay(now: Date): Date {
  return new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

async function markSkipped(deliveryId: string, reason: string): Promise<void> {
  await db.emailDelivery.update({ where: { id: deliveryId }, data: { status: 'skipped', detail: reason } });
}

/**
 * Recompute a campaign's counters from its rows (the truth), advance it to
 * 'sending' while rows remain, and to 'sent' + completedAt once the queue is
 * exhausted. Failures are kept visible: lastError names the count and the real
 * SMTP detail, and the status stays honest even when every single send failed.
 */
async function finaliseCampaign(campaignId: string): Promise<void> {
  const campaign = await db.emailCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!campaign || campaign.status === 'cancelled') return;
  const counts = await countDeliveries(campaignId);
  const lastFailed = counts.failed > 0
    ? await db.emailDelivery.findFirst({
      where: { campaignId, status: 'failed' },
      orderBy: { createdAt: 'desc' },
      select: { detail: true },
    })
    : null;
  const exhausted = counts.queued === 0;
  const lastError = counts.failed > 0
    ? `${counts.failed} recipient(s) could not be reached: ${lastFailed?.detail ?? 'unknown error'}`
    : null;
  await db.emailCampaign.update({
    where: { id: campaignId },
    data: {
      status: exhausted ? 'sent' : 'sending',
      completedAt: exhausted ? new Date() : null,
      recipientCount: counts.queued + counts.sent + counts.failed,
      sentCount: counts.sent,
      failedCount: counts.failed,
      skippedCount: counts.skipped,
      lastError,
    },
  });
}

/**
 * One ticker pass: oldest-first, paced, capped. Called from the 60-second
 * ticker next to runInviteQueue. Failure-isolated at every step — a broken
 * transport leaves rows queued, a single bad mailbox is recorded and the pass
 * carries on.
 */
export async function runCampaignQueue(now: Date = new Date()): Promise<TickOutcome> {
  const outcome: TickOutcome = { sent: 0, failed: 0, skipped: 0, skippedReason: null };

  const identity = siteIdentity();
  if (!identity) {
    outcome.skippedReason = 'site URL not configured — campaign mail stays queued';
    return outcome;
  }

  const sentToday = await db.emailDelivery.count({ where: { status: 'sent', sentAt: { gte: startOfUtcDay(now) } } });
  const remaining = mailDailyCap() - sentToday;
  if (remaining <= 0) {
    outcome.skippedReason = 'daily cap reached';
    return outcome;
  }

  const batch = await db.emailDelivery.findMany({
    where: { status: 'queued', campaign: { status: { in: ['queued', 'sending'] } } },
    orderBy: { createdAt: 'asc' },
    take: Math.min(PER_TICK, remaining),
    include: {
      campaign: { select: { id: true, subject: true, text: true, html: true, audience: true } },
    },
  });
  if (batch.length === 0) return outcome;

  // The exclusions are re-checked for the batch, not trusted from queue time:
  // a suppression or an account opt-out that lands while mail is queued must
  // still stop the send. One query per list for the whole batch.
  const emails = batch.map((row) => row.email);
  const suppressedRows = await db.emailSuppression.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  const suppressed = new Set(suppressedRows.map((r) => r.email));
  const accounts = new Map(
    (
      await db.user.findMany({
        where: { email: { in: emails } },
        select: { email: true, emailVerified: true, mailOptOutAt: true },
      })
    ).map((u) => [u.email, u]),
  );

  const touched = new Set<string>();
  for (const row of batch) {
    const account = accounts.get(row.email);
    if (suppressed.has(row.email)) {
      await markSkipped(row.id, 'unsubscribed');
      outcome.skipped += 1;
      touched.add(row.campaign.id);
      continue;
    }
    if (account?.mailOptOutAt) {
      await markSkipped(row.id, 'opt_out');
      outcome.skipped += 1;
      touched.add(row.campaign.id);
      continue;
    }
    if (row.campaign.audience === 'verified_users' && account && !account.emailVerified) {
      await markSkipped(row.id, 'unverified');
      outcome.skipped += 1;
      touched.add(row.campaign.id);
      continue;
    }

    let message: CampaignMailMessage;
    try {
      message = composeCampaign(row.campaign, row.email, identity);
    } catch (err) {
      // No signing key → no legitimate unsubscribe link → no send. Everything
      // stays queued and the reason is reported, never swallowed.
      outcome.skippedReason = err instanceof Error ? err.message : String(err);
      break;
    }

    const result = await sender(message, identity.siteName);
    if (result.ok) {
      await db.emailDelivery.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now, detail: null } });
      outcome.sent += 1;
      touched.add(row.campaign.id);
      continue;
    }
    if (/not configured/i.test(result.detail)) {
      // Transport gone: leave this row (and every later one) queued and say so.
      outcome.skippedReason = 'Gmail SMTP is not configured — campaign mail stays queued';
      break;
    }
    // A real per-recipient failure: record the mailer's own detail, keep going.
    await db.emailDelivery.update({
      where: { id: row.id },
      data: { status: 'failed', detail: result.detail.slice(0, 300) },
    });
    outcome.failed += 1;
    touched.add(row.campaign.id);
  }

  for (const campaignId of touched) await finaliseCampaign(campaignId);
  return outcome;
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Stop a campaign that has not finished. Its not-yet-sent rows are retired
 * (status 'skipped', detail 'cancelled') so nothing can be drained later, and
 * the campaign is closed. Already-sent mail cannot be recalled — cancelling a
 * completed campaign is refused rather than pretended.
 */
export async function cancelCampaign(id: string): Promise<{ cancelled: number }> {
  const campaign = await db.emailCampaign.findUnique({ where: { id } });
  if (!campaign) throw new Error(`Campaign ${id} not found.`);
  if (campaign.status === 'sent') throw new Error('This campaign was already sent — there is nothing to cancel.');
  if (campaign.status === 'cancelled') return { cancelled: 0 };

  const retired = await db.emailDelivery.updateMany({
    where: { campaignId: id, status: 'queued' },
    data: { status: 'skipped', detail: 'cancelled' },
  });
  const counts = await countDeliveries(id);
  await db.emailCampaign.update({
    where: { id },
    data: {
      status: 'cancelled',
      completedAt: new Date(),
      recipientCount: counts.queued + counts.sent + counts.failed,
      sentCount: counts.sent,
      failedCount: counts.failed,
      skippedCount: counts.skipped,
    },
  });
  return { cancelled: retired.count };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Promotional-mail health for the operator and the console header. */
export async function campaignStats(): Promise<CampaignStats> {
  const now = new Date();
  const [sentToday, grouped, suppressionCount] = await Promise.all([
    db.emailDelivery.count({ where: { status: 'sent', sentAt: { gte: startOfUtcDay(now) } } }),
    db.emailCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
    db.emailSuppression.count(),
  ]);
  const countsByStatus: Record<string, number> = {};
  for (const group of grouped) countsByStatus[group.status] = group._count._all;
  const dailyCap = mailDailyCap();
  return {
    smtpConfigured: Boolean(gmailConfig()),
    dailyCap,
    sentToday,
    remainingToday: Math.max(0, dailyCap - sentToday),
    countsByStatus,
    suppressionCount,
  };
}
