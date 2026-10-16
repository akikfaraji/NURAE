/**
 * NURAE — promotional mail: the shared type contract.
 *
 * This file is the interface between three layers that are built separately:
 *   - the campaign engine        (lib/nurae/email/campaigns.ts)
 *   - the operator agent tools    (lib/nurae/agents/platform-tools.ts)
 *   - the admin API + console UI  (app/api/admin/campaigns/*, app/admin/mail)
 *
 * Types only — no runtime code lives here, so every layer can depend on it
 * without pulling in the others (and importing it can never open a DB
 * connection or an SMTP transport).
 *
 * DESIGN RULES the engine must honour (they are contractual, not advisory):
 *   1. An unsubscribe is TERMINAL and global: the suppression list is
 *      consulted before every send, by every sender (campaigns AND invites).
 *   2. We never generate, guess or scrape addresses. The audience is always
 *      the platform's own registered users, selected by an explicit rule.
 *   3. A campaign never sends to the same address twice — the unique
 *      (campaignId, email) row in email_deliveries is the guard.
 *   4. Sends are paced and capped (NURAE_MAIL_DAILY_CAP), old-style queue
 *      draining, so a large audience cannot burn the Gmail sender reputation
 *      or trip Telegram/Gmail rate limits.
 *   5. Every campaign is authored first and sent second. Sending is a
 *      consequential action: it requires an explicit confirmation, and when
 *      an AI agent asks for it, a human approval as well.
 */

/** Who a campaign goes to. Explicit and inspectable — never "everyone, maybe". */
export type AudienceKind =
  /** Registered accounts whose email is verified (the default, safest choice). */
  | 'verified_users'
  /** Every registered account, verified or not. */
  | 'all_users'
  /** Accounts with at least one bot (the engaged customers). */
  | 'bot_owners'
  /** Accounts inside their free trial week. */
  | 'trial_users'
  /** Accounts on a paid plan (plus/pro). */
  | 'paid_users';

export const AUDIENCE_KINDS: readonly AudienceKind[] = [
  'verified_users',
  'all_users',
  'bot_owners',
  'trial_users',
  'paid_users',
] as const;

export function isAudienceKind(value: string): value is AudienceKind {
  return (AUDIENCE_KINDS as readonly string[]).includes(value);
}

/** Campaign lifecycle. */
export type CampaignStatus = 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed';

/** Per-recipient outcome. `skipped` is a deliberate non-send, never an error. */
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped';

/** Why a recipient was skipped — surfaced verbatim so the operator is never lied to. */
export type SkipReason = 'unsubscribed' | 'opt_out' | 'unverified';

/** What the operator/console supplies when authoring a campaign. */
export interface CampaignDraft {
  name: string;
  subject: string;
  /** Plain-text body. Always present — every mail ships text + html. */
  text: string;
  /** Optional HTML body; when omitted the engine derives one from `text`. */
  html?: string;
  audience: AudienceKind;
  /** 'admin' (console) or 'operator' (agent tool). Defaults to 'admin'. */
  createdBy?: string;
}

/** Audience size + exclusions, computed WITHOUT sending anything. */
export interface AudiencePreview {
  kind: AudienceKind;
  /** Addresses that would actually receive the mail. */
  recipients: number;
  /** Excluded because they are on the permanent suppression list. */
  excludedSuppressed: number;
  /** Excluded because the account itself opted out (User.mailOptOutAt). */
  excludedOptOut: number;
  /** Excluded because the audience rule requires a verified address. */
  excludedUnverified: number;
  /** A few masked addresses, so the operator can sanity-check the selection. */
  sample: string[];
}

export interface CampaignSummary {
  id: string;
  name: string;
  subject: string;
  audience: AudienceKind;
  status: CampaignStatus;
  createdBy: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  lastError: string | null;
  queuedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One delivery row, with the address masked for display. */
export interface DeliveryRow {
  emailMasked: string;
  status: DeliveryStatus;
  detail: string | null;
  sentAt: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  text: string;
  html: string | null;
  deliveries: DeliveryRow[];
}

/** Result of materialising a campaign's recipient list (before any send). */
export interface QueueOutcome {
  queued: number;
  skippedSuppressed: number;
  skippedOptOut: number;
  skippedUnverified: number;
}

/** Result of one ticker pass over the queue. */
export interface TickOutcome {
  sent: number;
  failed: number;
  skipped: number;
  /** Set when the pass stopped early (cap reached, SMTP down) — never silent. */
  skippedReason: string | null;
}

/** Promotional-mail health, for the operator and the console header. */
export interface CampaignStats {
  smtpConfigured: boolean;
  dailyCap: number;
  sentToday: number;
  remainingToday: number;
  countsByStatus: Record<string, number>;
  suppressionCount: number;
}
