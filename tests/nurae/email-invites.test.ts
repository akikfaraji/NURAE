/**
 * NURAE — email invite tests (Task 27): the consent-first invitation funnel.
 *
 *   - address validation/normalisation
 *   - opt-in records (dedupe, attribution), unsubscribed is terminal
 *   - optInAndInvite outcomes: sent / queued / already / invalid / unsubscribed
 *   - importContacts: consent gate, invalid stripping, caps, dedupe
 *   - the queue: oldest-first under the daily cap; reminders exactly once
 *   - the admin stats surface masks addresses
 *
 * The SMTP transport is replaced with an in-memory fake — no real mail ever
 * leaves the test process.
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';

import { pushTestSchema } from './helpers';
pushTestSchema();

const { db } = await import('../../src/lib/db');
const {
  __setInviteSender,
  importContacts,
  inviteDailyCap,
  inviteStats,
  normalizeEmail,
  optInAndInvite,
  recordOptIn,
  runInviteQueue,
  runInviteReminders,
  sendInviteFor,
  unsubscribeByChat,
} = await import('../../src/lib/nurae/email/invites');

interface FakeMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const fakeOk = () => {
  const mails: FakeMail[] = [];
  const fn = async (msg: FakeMail) => {
    mails.push(msg);
    return { ok: true, detail: 'sent' } as const;
  };
  return { mails, fn };
};

const fakeDown = () => async () => ({ ok: false, detail: 'Gmail SMTP is not configured.' }) as const;

afterAll(() => {
  __setInviteSender(null);
  delete process.env.NURAE_INVITE_DAILY_CAP;
  delete process.env.NURAE_SITE_URL;
});

// ---------------------------------------------------------------------------

describe('address handling', () => {
  test('normalizeEmail accepts real addresses and refuses junk', () => {
    expect(normalizeEmail('  Friend@Example.COM ')).toBe('friend@example.com');
    expect(normalizeEmail('a.b+tag@sub.domain.io')).toBe('a.b+tag@sub.domain.io');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('missing@tld')).toBeNull();
    expect(normalizeEmail('@nope.com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });
});

describe('opt-ins and unsubscribes', () => {
  test('recordOptIn dedupes and refreshes attribution', async () => {
    const first = await recordOptIn('dedupe@example.com', { chatId: '1001', botId: 'bot-a' });
    expect(first).toEqual({ ok: true, already: false });
    const second = await recordOptIn('dedupe@example.com', { chatId: '1002', botId: 'bot-b' });
    expect(second).toEqual({ ok: true, already: true });
    const row = await db.emailInvite.findUnique({ where: { email: 'dedupe@example.com' } });
    expect(row!.chatId).toBe('1002'); // attribution refreshed
    expect(row!.source).toBe('optin');
    expect(row!.status).toBe('pending');
  });

  test('unsubscribed is terminal — a re-opt-in is refused forever', async () => {
    await recordOptIn('gone@example.com', { chatId: '2001' });
    expect(await unsubscribeByChat('2001')).toBe(1);
    const re = await recordOptIn('gone@example.com', { chatId: '2001' });
    expect(re).toEqual({ ok: false, reason: 'unsubscribed' });
  });

  test('optInAndInvite maps every outcome honestly', async () => {
    process.env.NURAE_SITE_URL = 'https://invite.example';
    const { mails, fn } = fakeOk();
    __setInviteSender(fn);

    expect(await optInAndInvite('junk', {})).toMatchObject({ outcome: 'invalid' });

    expect(await optInAndInvite('sent@example.com', { chatId: '3001' })).toMatchObject({ outcome: 'sent' });
    expect(mails[0].to).toBe('sent@example.com');
    expect(mails[0].text).toContain('https://invite.example/?ref='); // referral-coded link
    expect(mails[0].html).toContain('invite.example');

    expect(await optInAndInvite('sent@example.com', {})).toMatchObject({ outcome: 'already' });
    expect(mails).toHaveLength(1); // never a second mail

    __setInviteSender(fakeDown());
    expect(await optInAndInvite('queued@example.com', {})).toMatchObject({ outcome: 'queued' });
    const queued = await db.emailInvite.findUnique({ where: { email: 'queued@example.com' } });
    expect(queued!.status).toBe('pending'); // not lost — the queue will send it

    __setInviteSender(null);
    delete process.env.NURAE_SITE_URL;
  });

  test('sendInviteFor refuses addresses that never opted in', async () => {
    const result = await sendInviteFor('never-opted@example.com');
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
  });
});

describe('importContacts', () => {
  test('refuses without the explicit consent flag', async () => {
    const result = await importContacts(['a@example.com', 'b@example.com'], { confirm: false });
    expect(result.refused).toBe('missing_confirmation');
    expect(result.accepted).toBe(0);
    expect(await db.emailInvite.count({ where: { email: 'a@example.com' } })).toBe(0);
  });

  test('strips invalid rows, dedupes, and never touches unsubscribed', async () => {
    await recordOptIn('already@example.com', { chatId: '4001' });
    await unsubscribeByChat('4001');

    const result = await importContacts(
      ['new1@example.com', 'new1@example.com', 'junk', 'already@example.com', ''],
      { confirm: true },
    );
    expect(result.accepted).toBe(1); // new1 only
    expect(result.duplicateInList).toBe(1);
    expect(result.invalid).toEqual(['junk']);
    expect(result.unsubscribedSkipped).toBe(1); // unsubscribed stays terminal even for the owner
    expect(await db.emailInvite.findUnique({ where: { email: 'new1@example.com' } })!.then((r) => r.source)).toBe('import');
  });

  test('caps the batch (imports are for consented lists, not dumps)', async () => {
    const dump = Array.from({ length: 700 }, (_, i) => `dump${i}@example.com`);
    const result = await importContacts(dump, { confirm: true });
    expect(result.accepted).toBe(500);
    const first500 = await db.emailInvite.count({ where: { email: { startsWith: 'dump' } } });
    expect(first500).toBe(500);
    // cleanup — later counts must not be polluted by this test
    await db.emailInvite.deleteMany({ where: { email: { startsWith: 'dump' } } });
  });
});

describe('invite queue (ticker job)', () => {
  test('drains pending rows oldest-first and respects the daily cap', async () => {
    process.env.NURAE_SITE_URL = 'https://queue.example';
    process.env.NURAE_INVITE_DAILY_CAP = '3';
    expect(inviteDailyCap()).toBe(3);

    // Seed: one invite already sent today (consumes part of the cap), four pending.
    // Earlier tests in this file leave pending rows behind (older createdAt =
    // first in the queue) — clear them so the drain order here is exact.
    const leftovers = await db.emailInvite.findMany({ where: { status: 'pending' }, select: { id: true, email: true } });
    for (const row of leftovers) {
      if (!row.email.startsWith('q-pending')) await db.emailInvite.delete({ where: { id: row.id } });
    }
    // Earlier tests also sent mail today — age their rows out of the cap window.
    await db.emailInvite.updateMany({
      where: { sentAt: { not: null }, email: { not: 'q-old-1@example.com' } },
      data: { sentAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    for (const [i, email] of ['q-old-1@example.com', 'q-pending-1@example.com', 'q-pending-2@example.com', 'q-pending-3@example.com', 'q-pending-4@example.com'].entries()) {
      await db.emailInvite.create({
        data: {
          email,
          source: 'import',
          status: i === 0 ? 'invited' : 'pending',
          ...(i === 0 ? { sentAt: new Date() } : {}),
        },
      });
    }

    const { mails, fn } = fakeOk();
    __setInviteSender(fn);
    const result = await runInviteQueue();
    // Cap 3 − 1 sent today = 2 sends this run; the rest stay pending for tomorrow.
    expect(result.sent).toBe(2);
    expect(mails.map((m) => m.to)).toEqual(['q-pending-1@example.com', 'q-pending-2@example.com']);
    const stillPending = await db.emailInvite.count({ where: { email: { startsWith: 'q-pending' }, status: 'pending' } });
    expect(stillPending).toBe(2);

    __setInviteSender(null);
    delete process.env.NURAE_INVITE_DAILY_CAP;
    delete process.env.NURAE_SITE_URL;
    // cleanup the queue rows so later tests (and the cap math) start clean
    await db.emailInvite.deleteMany({ where: { email: { startsWith: 'q-' } } });
  });

  test('a broken transport leaves rows pending instead of losing them', async () => {
    process.env.NURAE_SITE_URL = 'https://queue.example';
    await db.emailInvite.create({ data: { email: 'q-broken@example.com', source: 'optin', status: 'pending' } });
    __setInviteSender(fakeDown());
    const result = await runInviteQueue();
    expect(result.sent).toBe(0);
    const row = await db.emailInvite.findUnique({ where: { email: 'q-broken@example.com' } });
    expect(row!.status).toBe('pending');
    __setInviteSender(null);
    delete process.env.NURAE_SITE_URL;
    await db.emailInvite.delete({ where: { email: 'q-broken@example.com' } });
  });
});

describe('weekly reminders', () => {
  test('exactly one reminder 7+ days after the invite — never to unsubscribed', async () => {
    process.env.NURAE_SITE_URL = 'https://remind.example';
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    await db.emailInvite.create({
      data: { email: 'remind-me@example.com', source: 'optin', status: 'invited', sentAt: eightDaysAgo },
    });
    await db.emailInvite.create({
      data: { email: 'remind-gone@example.com', source: 'optin', status: 'unsubscribed', sentAt: eightDaysAgo },
    });

    const { mails, fn } = fakeOk();
    __setInviteSender(fn);
    expect(await runInviteReminders()).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('remind-me@example.com');
    expect(mails[0].subject.toLowerCase()).toContain('nudge');

    // remindedAt set + status advanced → the second pass sends nothing.
    const row = await db.emailInvite.findUnique({ where: { email: 'remind-me@example.com' } });
    expect(row!.status).toBe('reminded');
    expect(row!.remindedAt).toBeTruthy();
    expect(await runInviteReminders()).toBe(0);
    expect(mails).toHaveLength(1);

    __setInviteSender(null);
    delete process.env.NURAE_SITE_URL;
    await db.emailInvite.deleteMany({ where: { email: { startsWith: 'remind-' } } });
  });

  test('fresh invites (under 7 days) are never nudged', async () => {
    process.env.NURAE_SITE_URL = 'https://remind.example';
    await db.emailInvite.create({
      data: { email: 'remind-fresh@example.com', source: 'optin', status: 'invited', sentAt: new Date() },
    });
    const { mails, fn } = fakeOk();
    __setInviteSender(fn);
    expect(await runInviteReminders()).toBe(0);
    expect(mails).toHaveLength(0);
    __setInviteSender(null);
    delete process.env.NURAE_SITE_URL;
    await db.emailInvite.delete({ where: { email: 'remind-fresh@example.com' } });
  });
});

describe('admin stats', () => {
  test('counts by status and masks every address', async () => {
    await db.emailInvite.create({ data: { email: 'stats-hidden@example.com', source: 'optin', status: 'pending' } });
    const stats = (await inviteStats()) as {
      total: number;
      counts: Record<string, number>;
      recent: Array<{ email: string }>;
      smtpConfigured: boolean;
    };
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.counts.pending).toBeGreaterThan(0);
    expect(typeof stats.smtpConfigured).toBe('boolean');
    for (const row of stats.recent) {
      expect(row.email).toMatch(/^[^@]*\*@/); // local part masked
    }
    await db.emailInvite.delete({ where: { email: 'stats-hidden@example.com' } });
  });
});
