/**
 * NURAE — referrals + temporary entitlements.
 *
 * Flow (all server-side; the client can only present a code):
 *   1. Inviter gets a shareable link https://<host>/?ref=<code> (lazy code).
 *   2. A new visitor signs up through that link → a PENDING ReferralReward
 *      row is recorded (who invited whom, when). Self-referral and duplicate
 *      claims are refused at the schema level (unique invited user) and the
 *      service level (inviter ≠ invited, one code per inviter).
 *   3. When the invited account VERIFIES its email, the reward qualifies:
 *      the inviter receives an Entitlement ("premium") for REWARD_DAYS days.
 *
 * Entitlements are deliberately NOT a "premium" boolean: they are per-feature
 * grants with expiry, so future rewards (extra agent runs, storage, models)
 * fit without another migration. The frontend never decides entitlements —
 * `hasEntitlement` is the only gate and it lives here.
 */

import { db } from '@/lib/db';
import { randomBytes } from 'node:crypto';

export const REWARD_DAYS = 2;
export const REWARD_FEATURE = 'premium';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no lookalikes

function newCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Get (or lazily create) the inviter's referral code. */
export async function getOrCreateInvite(userId: string): Promise<{ code: string; createdAt: Date }> {
  const existing = await db.referral.findUnique({ where: { inviterId: userId } });
  if (existing) return { code: existing.code, createdAt: existing.createdAt };
  // Retry once on the (unlikely) code collision — the code is unique.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await db.referral.create({ data: { inviterId: userId, code: newCode() } });
      return { code: row.code, createdAt: row.createdAt };
    } catch {
      /* duplicate code — retry */
    }
  }
  throw new Error('Could not allocate a referral code');
}

export interface ReferralStats {
  code: string;
  invited: number;
  qualified: number;
  rewardDaysTotal: number;
}

export async function referralStats(userId: string): Promise<ReferralStats> {
  const invite = await getOrCreateInvite(userId);
  const rewards = await db.referralReward.findMany({
    where: { inviterId: userId },
    select: { status: true, days: true },
  });
  const qualified = rewards.filter((r) => r.status === 'qualified');
  return {
    code: invite.code,
    invited: rewards.length,
    qualified: qualified.length,
    rewardDaysTotal: qualified.reduce((sum, r) => sum + r.days, 0),
  };
}

/**
 * Record an invite at sign-up time. Safe to call with garbage: unknown codes
 * and self-invites simply return false. A pending reward for the same
 * invited user is never duplicated (the DB unique index backs this up).
 */
export async function recordReferralSignup(invitedUserId: string, rawCode: string | null | undefined): Promise<boolean> {
  const code = (rawCode ?? '').trim().toUpperCase();
  if (!code) return false;
  const invite = await db.referral.findUnique({ where: { code } });
  if (!invite) return false;
  if (invite.inviterId === invitedUserId) return false; // self-referral
  const existing = await db.referralReward.findUnique({ where: { invitedUserId } });
  if (existing) return false; // one reward per invited user, ever
  try {
    await db.referralReward.create({
      data: { inviterId: invite.inviterId, invitedUserId, days: REWARD_DAYS, status: 'pending' },
    });
    return true;
  } catch {
    return false; // raced duplicate — lose silently
  }
}

/**
 * Qualify pending rewards when the invited user verifies their email.
 * Grants the inviter's entitlement (extending an active one if present).
 */
export async function qualifyReferralForUser(invitedUserId: string): Promise<number> {
  const pending = await db.referralReward.findMany({
    where: { invitedUserId, status: 'pending' },
  });
  let granted = 0;
  for (const reward of pending) {
    await db.referralReward.update({
      where: { id: reward.id },
      data: { status: 'qualified', qualifiedAt: new Date() },
    });
    await grantEntitlement(reward.inviterId, REWARD_FEATURE, reward.days, 'referral');
    granted++;
  }
  return granted;
}

/** Grant (or extend) a temporary feature entitlement. */
export async function grantEntitlement(userId: string, feature: string, days: number, source: string): Promise<void> {
  const now = Date.now();
  const active = await db.entitlement.findFirst({
    where: { userId, feature, expiresAt: { gt: new Date(now) } },
    orderBy: { expiresAt: 'desc' },
  });
  const base = active ? active.expiresAt.getTime() : now;
  const expiresAt = new Date(base + days * 24 * 60 * 60 * 1000);
  if (active) {
    await db.entitlement.update({ where: { id: active.id }, data: { expiresAt } });
  } else {
    await db.entitlement.create({ data: { userId, feature, source, expiresAt } });
  }
}

/** The single entitlement gate (server-side only, never the client). */
export async function hasEntitlement(userId: string, feature: string): Promise<boolean> {
  const row = await db.entitlement.findFirst({
    where: { userId, feature, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return Boolean(row);
}
