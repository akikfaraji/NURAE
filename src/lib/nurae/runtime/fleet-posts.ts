/**
 * NURAE — fleet daily posts: the official bots' coordinated group promotion.
 *
 * When a platform bot lands in a group/channel, the pipeline arms ONE daily
 * schedule whose text is the sentinel `@nurae:fleet-daily` — a placeholder,
 * not copy. At send time (the 60-second ticker) the sentinel is rendered
 * into that day's post: the rotation below cycles through NURAE promotion,
 * invite challenges, community plugs and engagement questions, always with
 * the instance's real links and the platform referral code baked in. Bots
 * never post the same pitch two days running, and the posting hour is
 * staggered per bot (chat hour + bot offset) so two fleet bots in one room
 * do not talk over each other.
 *
 * syncFleetAutomation() runs on the ticker every ~10 minutes as the
 * zero-touch backfill: it arms missing schedules for chats the bot already
 * knows and migrates v2-era static daily posts to the sentinel — so every
 * server that updates starts promoting without anyone touching a button.
 *
 * Admin control stays real: editing the schedule row (or deleting it)
 * disables the rotation for that chat — an edited text is never overwritten.
 */

import { db } from '@/lib/db';
import type { RuntimeStore } from './store';
import { growthLinksFromEnv } from '../bots/growth-links';
import { platformReferralCode } from '../auth/official-fleet';

/** Schedule rows carrying exactly this text are rendered fresh every day. */
export const FLEET_DAILY_SENTINEL = '@nurae:fleet-daily';

/** v2-era static text (starts-with match) → migrated to the sentinel. */
const LEGACY_AUTOMATION_PREFIX = '🔥 *Daily round with ';

/**
 * Stable per-bot hour offset (0–23): two fleet bots added to the same chat
 * post at different hours instead of stacking at the same minute.
 */
export function botHourOffset(botId: string): number {
  let hash = 0;
  for (let i = 0; i < botId.length; i += 1) {
    hash = (hash * 31 + botId.charCodeAt(i)) >>> 0;
  }
  return hash % 24;
}

/** Posting hour for a bot+chat pair (UTC). */
export function fleetPostHour(botId: string, chatId: string): number {
  const key = Number.isFinite(Number(chatId)) ? BigInt(chatId) : BigInt(0);
  return Number((key % BigInt(24) + BigInt(botHourOffset(botId))) % BigInt(24));
}

function dayHash(dayKey: string): number {
  let hash = 0;
  for (let i = 0; i < dayKey.length; i += 1) {
    hash = (hash * 17 + dayKey.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * The daily rotation. Every variant is real NURAE promotion: it sells the
 * platform, pushes the referral/invite loop, or funnels to the instance's
 * community — with all links resolved at render time so env changes apply
 * without touching the bots.
 */
const ROTATION: Array<(botName: string, links: { site: string | null; community: string | null; channel: string | null; ref: string }) => string> = [
  // 0 — the platform pitch (the user's ask: the bot promotes NURAE in groups)
  (_botName, l) =>
    [
      '🤖 *How this bot exists*',
      '',
      'Everything here — the games, the rewards, the answers — runs on **NURAE**: describe a bot in plain English and NURAE builds it, hosts it and runs it on Telegram.',
      '',
      l.site
        ? `Build your own in minutes → ${l.site}/?ref=${l.ref}`
        : 'Build your own in minutes — ask the admin for an invite.',
    ].join('\n'),
  // 1 — the invite loop (growth compounds when members recruit)
  (botName, l) =>
    [
      `🎯 *${botName} challenge of the day*`,
      '',
      'Bring one friend today: press Start on the bot, grab your personal invite link and share it. Every arrival counts on the leaderboard — the top names get noticed first.',
      '',
      l.site ? `Know a builder? NURAE turns ideas into bots: ${l.site}/?ref=${l.ref}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  // 2 — the community funnel
  (_botName, l) =>
    [
      '🌍 *Never miss what is coming*',
      '',
      'The big announcements land in the official community first — new features, events, giveaways. The people who join early always get the best of it.',
      '',
      l.channel ? `📢 Announcements channel: ${l.channel}` : '',
      l.community ? '💬 Community chat: ' + l.community : '',
    ]
      .filter(Boolean)
      .join('\n'),
  // 3 — the engagement question (comments train the algorithm and keep rooms alive)
  (botName, _l) =>
    [
      `💬 *Quick one for the ${botName} crowd*`,
      '',
      'Reply in the chat: what should this bot do that it does not do yet? The best idea gets built — and the admin is listening.',
      '',
      'Meanwhile: press Start on the bot and try today’s round.',
    ].join('\n'),
  // 4 — the free-tier pitch (the strongest honest hook the platform has)
  (_botName, l) =>
    [
      '⚡ *Free for a week. Free tier forever.*',
      '',
      'NURAE gives every new account a 7-day free server week — and after that, every feature keeps a free daily allowance. A full bot can run on $0, forever.',
      '',
      l.site ? `Start free → ${l.site}/?ref=${l.ref}` : 'Start free — ask the admin for an invite.',
    ].join('\n'),
];

/** Render the day's fleet post for one bot (markdown; ticker converts to HTML). */
export function renderFleetDailyPost(botName: string, dayKey: string): string {
  const links = growthLinksFromEnv();
  const ctx = {
    site: links?.siteUrl ?? null,
    community: links?.communityUrl ?? null,
    channel: links?.channelUrl ?? null,
    ref: platformReferralCode(),
  };
  return ROTATION[dayHash(dayKey) % ROTATION.length](botName, ctx);
}

/** Next occurrence of hour:00 UTC strictly in the future. */
function nextRunAt(hour: number, now: Date): Date {
  const runAt = new Date(now);
  runAt.setUTCHours(hour, 0, 0, 0);
  if (runAt.getTime() <= now.getTime()) runAt.setUTCDate(runAt.getUTCDate() + 1);
  return runAt;
}

export interface FleetSyncResult {
  bots: number;
  armed: number;
  migrated: number;
  skippedThrottle?: boolean;
}

const SYNC_INTERVAL_MS = 10 * 60_000;
const globalForSync = globalThis as unknown as { nuraeFleetSyncLast: number | undefined };

/**
 * Zero-touch backfill (ticker, throttled to ~10 min per process):
 *   - arms the sentinel daily post for every fleet-bot chat that has none;
 *   - migrates v2 static daily posts to the sentinel (rotation takes over).
 * User-owned bots are never touched — automation stays a fleet feature.
 */
export async function syncFleetAutomation(store: RuntimeStore, now: Date = new Date()): Promise<FleetSyncResult> {
  const last = globalForSync.nuraeFleetSyncLast ?? 0;
  if (now.getTime() - last < SYNC_INTERVAL_MS) {
    return { bots: 0, armed: 0, migrated: 0, skippedThrottle: true };
  }
  globalForSync.nuraeFleetSyncLast = now.getTime();

  const result: FleetSyncResult = { bots: 0, armed: 0, migrated: 0 };
  const bots = await db.bot
    .findMany({
      where: { ownerId: null, enabled: true },
      select: { id: true, name: true, telegramTokenRef: true },
    })
    .catch(() => []);
  result.bots = bots.length;

  for (const bot of bots) {
    if (!bot.telegramTokenRef) continue;
    const chats = await store.listChatIds(bot.id).catch(() => [] as string[]);
    for (const chatId of chats) {
      // Automation targets groups/channels only (negative ids). Private DMs
      // never get unsolicited posts.
      if (!chatId.startsWith('-')) continue;
      const schedules = await store.listSchedules(bot.id).catch(() => []);
      const existing = schedules.find((s) => s.chatId === chatId && s.recurrence === 'daily' && s.status === 'pending');
      if (!existing) {
        await store.createSchedule({
          botId: bot.id,
          chatId,
          text: FLEET_DAILY_SENTINEL,
          runAt: nextRunAt(fleetPostHour(bot.id, chatId), now),
          recurrence: 'daily',
          createdBy: null,
        });
        result.armed += 1;
        continue;
      }
      if (existing.text.startsWith(LEGACY_AUTOMATION_PREFIX) && existing.text !== FLEET_DAILY_SENTINEL) {
        await store.updateScheduleText(existing.id, FLEET_DAILY_SENTINEL).catch(() => undefined);
        result.migrated += 1;
      }
    }
  }
  return result;
}
