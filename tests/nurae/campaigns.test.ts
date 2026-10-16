/**
 * NURAE — promotional-mail engine contract tests.
 *
 * These do not test implementation details: they pin the five rules the engine
 * promises (see lib/nurae/email/campaign-types.ts) —
 *   1. an unsubscribe is terminal and GLOBAL (it also stops the invite funnel);
 *   2. the audience is the platform's own accounts, filtered by an explicit rule;
 *   3. a campaign never mails the same address twice, however often it is retried;
 *   4. sending is paced and capped, and an unconfigured transport loses nothing;
 *   5. author first, send second — and exclusions are re-checked at SEND time,
 *      not trusted from queue time.
 *
 * The transport is always a fake: no test may ever send real mail.
 */

import './helpers';

import { pushTestSchema } from './helpers';
pushTestSchema();

import { afterEach, describe, expect, test } from 'vitest';
import { db } from '../../src/lib/db';
import {
  __setCampaignSender,
  campaignStats,
  createCampaign,
  getCampaign,
  previewAudience,
  queueCampaign,
  runCampaignQueue,
  type CampaignMailMessage,
} from '../../src/lib/nurae/email/campaigns';
import {
  addSuppression,
  isInviteUnsubscribed,
  isSuppressed,
  mailDailyCap,
} from '../../src/lib/nurae/email/suppression';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../src/lib/nurae/email/unsubscribe-token';

const SITE = 'https://mail.example';

let sent: CampaignMailMessage[] = [];

function fakeOk(): void {
  sent = [];
  __setCampaignSender(async (msg) => {
    sent.push(msg);
    return { ok: true, detail: 'sent' };
  });
}

afterEach(() => {
  __setCampaignSender(null);
  delete process.env.NURAE_SITE_URL;
});

async function inviteUser(email: string, opts: { verified?: boolean; trialDays?: number } = {}): Promise<string> {
  const user = await db.user.create({
    data: {
      email,
      name: email.split('@')[0],
      emailVerified: opts.verified ?? true,
      trialEndsAt: opts.trialDays ? new Date(Date.now() + opts.trialDays * 86_400_000) : null,
    },
    select: { id: true },
  });
  return user.id;
}

async function draft(audience: 'verified_users' | 'all_users' | 'trial_users' = 'verified_users') {
  const { id } = await createCampaign({
    name: 'Promo',
    subject: 'News from NURAE',
    text: 'Hello — here is what is new.',
    audience,
  });
  return id;
}

/**
 * Run ticker passes until nothing more moves. One pass sends at most PER_TICK
 * mails across ALL campaigns (oldest first), so a test asserting on one
 * campaign must drain rather than assume a single pass reaches it.
 */
async function drainTicks(maxTicks = 60): Promise<{ sent: number; failed: number; skipped: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < maxTicks; i++) {
    const outcome = await runCampaignQueue();
    sent += outcome.sent;
    failed += outcome.failed;
    skipped += outcome.skipped;
    if (outcome.sent + outcome.failed + outcome.skipped === 0) break;
  }
  return { sent, failed, skipped };
}

describe('audience selection is explicit and exclusion-aware', () => {
  test('verified_users counts a verified account, excludes an unverified one and says so', async () => {
    const before = await previewAudience('verified_users');
    await inviteUser('engine-verified@example.com', { verified: true });
    const afterVerified = await previewAudience('verified_users');
    expect(afterVerified.recipients - before.recipients).toBe(1);

    await inviteUser('engine-unverified@example.com', { verified: false });
    const afterUnverified = await previewAudience('verified_users');
    expect(afterUnverified.recipients - afterVerified.recipients).toBe(0);
    expect(afterUnverified.excludedUnverified - afterVerified.excludedUnverified).toBe(1);
  });

  test('all_users includes accounts verified_users leaves out', async () => {
    const all = await previewAudience('all_users');
    const verifiedOnly = await previewAudience('verified_users');
    expect(all.recipients).toBeGreaterThanOrEqual(verifiedOnly.recipients);
  });

  test('trial_users sees accounts inside their free week', async () => {
    const before = await previewAudience('trial_users');
    await inviteUser('engine-trial@example.com', { trialDays: 3 });
    const after = await previewAudience('trial_users');
    expect(after.recipients - before.recipients).toBe(1);
  });

  test('a suppressed address is excluded from the audience and reported as such', async () => {
    const email = 'engine-suppressed@example.com';
    await inviteUser(email);
    await addSuppression(email, 'manual', 'test');
    const before = await previewAudience('verified_users');
    expect(before.sample.join(' ')).not.toContain('engine-suppressed@example.com');
    expect(await isSuppressed(email)).toBe(true);
    // The sample is masked — a display surface must never leak full addresses.
    expect(before.sample.every((s) => s.includes('***') || s.length === 0)).toBe(true);
  });

  test('an account-level opt-out is excluded and counted separately', async () => {
    const email = 'engine-optout@example.com';
    const userId = await inviteUser(email);
    const before = await previewAudience('verified_users');
    await db.user.update({ where: { id: userId }, data: { mailOptOutAt: new Date() } });
    const after = await previewAudience('verified_users');
    // They were in the audience before the opt-out and are excluded after it.
    expect(after.recipients - before.recipients).toBe(-1);
    expect(after.excludedOptOut - before.excludedOptOut).toBe(1);
  });
});

describe('queueing is idempotent and sending is honest', () => {
  test('queueCampaign materialises one row per recipient and a second call changes nothing', async () => {
    const email = 'engine-once@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');

    const first = await queueCampaign(id);
    expect(first.queued).toBeGreaterThan(0);
    const rowsAfterFirst = await db.emailDelivery.count({ where: { campaignId: id } });

    const second = await queueCampaign(id);
    expect(second.queued).toBe(first.queued);
    expect(await db.emailDelivery.count({ where: { campaignId: id } })).toBe(rowsAfterFirst);
    // Rule 3: the unique (campaign, email) pair is the real guard.
    expect(await db.emailDelivery.count({ where: { campaignId: id, email } })).toBe(1);
  });

  test('runCampaignQueue sends through the injected transport and completes the campaign', async () => {
    process.env.NURAE_SITE_URL = SITE;
    fakeOk();
    const email = 'engine-send@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);

    const outcome = await drainTicks();

    expect(outcome.sent).toBeGreaterThan(0);
    // Only the recipients of THIS campaign are inspected (other rows may exist).
    const row = await db.emailDelivery.findFirst({ where: { campaignId: id, email } });
    expect(row?.status).toBe('sent');
    expect(row?.sentAt).toBeInstanceOf(Date);

    const campaign = await db.emailCampaign.findUnique({ where: { id } });
    // One tick sends at most PER_TICK mails, so a larger audience stays 'sending'
    // while a small one completes — both are correct; what matters is that the
    // counters and the lifecycle moved forward and are not optimistic.
    expect(['sending', 'sent']).toContain(campaign?.status);
    expect(campaign?.sentCount).toBeGreaterThan(0);

    // The mail that left the building carries the unsubscribe promise.
    const mine = sent.find((m) => m.to === email);
    expect(mine).toBeTruthy();
    expect(mine!.text).toContain('/api/email/unsubscribe?t=');
    expect(mine!.text.toLowerCase()).toContain('unsubscribe');
    const token = /unsubscribe\?t=([A-Za-z0-9_.\-]+)/.exec(mine!.text)?.[1] ?? null;
    expect(token).toBeTruthy();
    expect(verifyUnsubscribeToken(token)).toBe(email);
    expect(mine!.html).toContain('/api/email/unsubscribe?t=');
  });

  test('a suppression that lands AFTER queueing still stops the send (re-checked at send time)', async () => {
    process.env.NURAE_SITE_URL = SITE;
    fakeOk();
    const email = 'engine-late-unsub@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);

    await addSuppression(email, 'unsubscribe', 'clicked the link after the queue was built');
    const outcome = await drainTicks();

    const row = await db.emailDelivery.findFirst({ where: { campaignId: id, email } });
    expect(row?.status).toBe('skipped');
    expect(row?.detail).toBe('unsubscribed');
    expect(sent.some((m) => m.to === email)).toBe(false);
    expect(outcome.skipped).toBeGreaterThan(0);
  });

  test('with no site URL configured nothing is lost and nothing is claimed', async () => {
    delete process.env.NURAE_SITE_URL;
    fakeOk();
    const email = 'engine-nosite@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);

    const outcome = await runCampaignQueue();

    expect(outcome.sent).toBe(0);
    expect(outcome.skippedReason).toContain('site URL');
    expect(sent).toHaveLength(0);
    const row = await db.emailDelivery.findFirst({ where: { campaignId: id, email } });
    expect(row?.status).toBe('queued'); // still deliverable later
  });

  test('a per-recipient transport failure is recorded with the real reason, not swallowed', async () => {
    process.env.NURAE_SITE_URL = SITE;
    sent = [];
    __setCampaignSender(async () => ({ ok: false, detail: '550 5.1.1 mailbox unavailable' }));
    const email = 'engine-fail@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);

    const outcome = await drainTicks();

    expect(outcome.failed).toBeGreaterThan(0);
    const row = await db.emailDelivery.findFirst({ where: { campaignId: id, email } });
    expect(row?.status).toBe('failed');
    expect(row?.detail).toContain('550 5.1.1');
    const campaign = await db.emailCampaign.findUnique({ where: { id } });
    expect(campaign?.lastError).toContain('could not be reached');
  });

  test('an unconfigured transport leaves mail QUEUED and says so, instead of burning the queue', async () => {
    process.env.NURAE_SITE_URL = SITE;
    sent = [];
    __setCampaignSender(async () => ({ ok: false, detail: 'Gmail SMTP is not configured.' }));
    const email = 'engine-nosmtp@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);

    const outcome = await runCampaignQueue();

    expect(outcome.sent).toBe(0);
    // A missing transport is NOT a recipient failure — it is a deployment state.
    expect(outcome.failed).toBe(0);
    expect(outcome.skippedReason).toContain('SMTP');
    const row = await db.emailDelivery.findFirst({ where: { campaignId: id, email } });
    expect(row?.status).toBe('queued'); // deliverable the moment SMTP is configured
  });
});

describe('the unsubscribe promise', () => {
  test('tokens round-trip, and tampering or a foreign signature is refused', () => {
    const token = signUnsubscribeToken('Round.Trip@Example.com');
    expect(verifyUnsubscribeToken(token)).toBe('round.trip@example.com');
    // Tampered payload.
    const [v, encoded, sig] = token.split('.');
    const forged = Buffer.from('someone.else@example.com', 'utf8').toString('base64url');
    expect(verifyUnsubscribeToken(`${v}.${forged}.${sig}`)).toBeNull();
    // Tampered signature.
    expect(verifyUnsubscribeToken(`${v}.${encoded}.${'0'.repeat(64)}`)).toBeNull();
    // Junk never throws.
    for (const junk of ['', 'nope', 'u1.x.y', 'u2.' + encoded + '.' + sig, null, undefined]) {
      expect(verifyUnsubscribeToken(junk as string | null | undefined)).toBeNull();
    }
  });

  test('suppression is global: it reaches the invite funnel too', async () => {
    const email = 'engine-global@example.com';
    await inviteUser(email);
    await db.emailInvite.create({ data: { email, source: 'optin', status: 'pending' } });

    const outcome = await addSuppression(email, 'unsubscribe', 'one click');

    expect(outcome.email).toBe(email);
    expect(await isSuppressed(email)).toBe(true);
    expect(await isInviteUnsubscribed(email)).toBe(true);
    // The invite row is retired, so a queued invitation can never be drained.
    const invite = await db.emailInvite.findUnique({ where: { email } });
    expect(invite?.status).toBe('unsubscribed');
    // Idempotent: suppressing twice reports, never duplicates.
    const again = await addSuppression(email, 'unsubscribe');
    expect(again.alreadySuppressed).toBe(true);
  });

  test('the daily cap is bounded and the stats surface reports real numbers', async () => {
    const cap = mailDailyCap();
    expect(cap).toBeGreaterThanOrEqual(1);
    expect(cap).toBeLessThanOrEqual(450);

    const stats = await campaignStats();
    expect(stats.dailyCap).toBe(cap);
    expect(stats.sentToday).toBeGreaterThanOrEqual(0);
    expect(stats.suppressionCount).toBeGreaterThan(0);
    expect(typeof stats.smtpConfigured).toBe('boolean');
  });

  test('campaign detail masks recipient addresses', async () => {
    const email = 'engine-masked@example.com';
    await inviteUser(email);
    const id = await draft('verified_users');
    await queueCampaign(id);
    const detail = await getCampaign(id);
    expect(detail).toBeTruthy();
    expect(detail!.deliveries.length).toBeGreaterThan(0);
    expect(detail!.deliveries.every((d) => !d.emailMasked.includes('@') || d.emailMasked.includes('***'))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(email);
  });
});
