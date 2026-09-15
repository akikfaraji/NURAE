/**
 * NURAE — the PLATFORM tool tier: what the operator agent (the instance
 * admin's agent) can do to the whole server, not just one user's bots.
 *
 * Every spec here declares `platformRequired: true`. executeTool refuses
 * these calls unless the ToolContext carries `platform: true` — and that
 * flag is set ONLY by the admin-authenticated operator route (the same
 * NURAE_ADMIN_TOKEN guard the rest of the dashboard uses). Identity never
 * comes from the model, a request body, or a URL.
 *
 * The tier mirrors the admin dashboard's own powers: platform overview,
 * any bot's full configuration, the official fleet (status/ensure/update),
 * platform logs, site settings, customers, engagement analytics. Secrets
 * (tokens, AI keys, SMTP credentials) are NEVER returned — booleans only.
 */

import { z } from 'zod';
import { db } from '@/lib/db';
import type { ToolContext, ToolOutcome, ToolSpec } from './tools';
import { loadBehaviors } from '../bots/behavior';
import { loadCapabilities } from '../bots/capabilities';
import { ensureOfficialFleet, officialFleetStatus } from '../auth/official-fleet';
import { growthLinksFromEnv } from '../bots/growth-links';
import { getSiteInfo, saveSiteInfo } from '../auth/settings';
import { NURAE_VERSION } from '../version';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(label: string, data?: unknown): ToolOutcome {
  return { label, status: 'error', data };
}

const botIdSchema = z.string().min(1).max(64);

/** Any bot by id (operator scope — no ownership filter, still no secrets). */
async function anyBot(botId: string) {
  return db.bot.findUnique({ where: { id: botId } });
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const platformOverview: ToolSpec = {
  name: 'platform_overview',
  description:
    'One honest snapshot of the whole server: version, bot/user/conversation/message counts ' +
    '(24h deltas), pending schedules, official fleet readiness, which AI provider env keys and ' +
    'SMTP are configured, and whether the site URL resolves. Read this FIRST whenever asked ' +
    '"how are we doing" or "is everything running". Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z.object({}).strict(),
  async exec() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      bots,
      platformBots,
      runningBots,
      users,
      conversations,
      messagesAll,
      messages24h,
      pendingSchedules,
      fleet,
      settings,
    ] = await Promise.all([
      db.bot.count(),
      db.bot.count({ where: { ownerId: null } }),
      db.bot.count({ where: { status: 'running' } }),
      db.user.count(),
      db.conversation.count(),
      db.message.count(),
      db.message.count({ where: { timestamp: { gte: since24h } } }),
      db.botSchedule.count({ where: { status: 'pending' } }),
      officialFleetStatus(),
      getSiteInfo(),
    ]);
    const fleetReady = fleet.filter((f) => f.botId && f.hasTelegramToken && f.ready).length;
    return {
      label: `Platform overview — ${bots} bot(s), ${users} user(s), ${messages24h} message(s) in 24h`,
      data: {
        version: NURAE_VERSION,
        bots: { total: bots, platformOwned: platformBots, running: runningBots },
        users: users,
        conversations: conversations,
        messages: { total: messagesAll, last24h: messages24h },
        schedulesPending: pendingSchedules,
        fleet: { total: fleet.length, ready: fleetReady, bots: fleet.map((f) => ({ name: f.name, ready: f.ready, hasTelegramToken: f.hasTelegramToken, status: f.status })) },
        configured: {
          siteUrl: growthLinksFromEnv()?.siteUrl ?? null,
          aiEnvKeys: {
            openai: Boolean(process.env.OPENAI_API_KEY),
            openrouter: Boolean(process.env.OPENROUTER_API_KEY),
            deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
            glm: Boolean(process.env.GLM_API_KEY),
            local: Boolean(process.env.LOCAL_API_KEY),
          },
          smtp: Boolean(process.env.NURAE_GMAIL_USER && process.env.NURAE_GMAIL_APP_PASSWORD),
          referralCode: process.env.NURAE_REFERRAL_CODE || 'nurae (vanity default)',
        },
        site: { name: settings.siteName, tagline: settings.tagline },
      },
    };
  },
};

const botsListAll: ToolSpec = {
  name: 'bots_list_all',
  description:
    'List EVERY bot on the server (user-owned AND platform fleet) with id, name, owner kind, ' +
    'status, enabled, provider/model, token/AI-key presence and behavior count. Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z
    .object({ limit: z.number().int().min(1).max(200).default(50) })
    .strict(),
  async exec(_ctx, args) {
    const { limit } = args as { limit: number };
    const rows = await db.bot.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        ownerId: true,
        status: true,
        enabled: true,
        provider: true,
        model: true,
        telegramTokenRef: true,
        apiKeyRef: true,
        telegramUsername: true,
        behaviorsJson: true,
        updatedAt: true,
      },
    });
    const bots = rows.map((r) => {
      let behaviors = 0;
      try {
        behaviors = loadBehaviors({ behaviorsJson: r.behaviorsJson }).length;
      } catch {
        behaviors = 0;
      }
      return {
        id: r.id,
        name: r.name,
        ownedBy: r.ownerId ? 'customer' : 'platform (official fleet)',
        status: r.status,
        enabled: r.enabled,
        provider: r.provider,
        model: r.model,
        hasTelegramToken: Boolean(r.telegramTokenRef),
        hasApiKey: Boolean(r.apiKeyRef),
        telegramUsername: r.telegramUsername,
        behaviors,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
    return { label: `Listed ${bots.length} bot(s) across the server`, data: { bots } };
  },
};

const platformBotGet: ToolSpec = {
  name: 'platform_bot_get',
  description:
    'Read ANY bot\\u2019s full configuration (fleet or customer-owned): identity, AI settings, ' +
    'commands, replies, behaviors, status. Use it to diagnose "why is this bot behaving like ' +
    'that". Secrets are never included. Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z.object({ botId: botIdSchema }).strict(),
  async exec(_ctx, args) {
    const { botId } = args as { botId: string };
    const row = await anyBot(botId);
    if (!row) return fail(`No bot with id ${botId} exists on this server.`);
    const caps = loadCapabilities(row);
    return {
      label: `Inspected "${row.name}" (${row.ownerId ? 'customer' : 'fleet'} bot)`,
      data: {
        id: row.id,
        name: row.name,
        description: row.description,
        ownedBy: row.ownerId ? 'customer' : 'platform (official fleet)',
        status: row.status,
        statusDetail: row.statusDetail,
        enabled: row.enabled,
        transport: row.transport,
        telegramUsername: row.telegramUsername,
        hasTelegramToken: Boolean(row.telegramTokenRef),
        hasApiKey: Boolean(row.apiKeyRef),
        provider: row.provider,
        model: row.model,
        temperature: row.temperature,
        memorySize: row.memorySize,
        systemPrompt: row.systemPrompt.slice(0, 2000),
        commands: caps.commands,
        repliesCount: caps.replies.length,
        behaviors: loadBehaviors(row),
      },
    };
  },
};

const fleetStatus: ToolSpec = {
  name: 'fleet_status',
  description:
    'The official NURAE fleet (platform-owned promotion bots): per bot \\u2014 seeded? token? AI ' +
    'ready? running status? Telegram username? Read-only; pair with fleet_ensure to repair.',
  kind: 'read',
  platformRequired: true,
  schema: z.object({}).strict(),
  async exec() {
    const fleet = await officialFleetStatus();
    return {
      label: `Fleet status — ${fleet.filter((f) => f.botId).length}/${fleet.length} seeded`,
      data: fleet,
    };
  },
};

const platformLogs: ToolSpec = {
  name: 'platform_logs',
  description:
    'Recent platform log rows (newest first) — the fastest way to answer "what happened". ' +
    'Filters: level (info|warn|error), event (e.g. SCHEDULE_SENT, AGENT_TOOL, OFFICIAL_FLEET_UPGRADED), ' +
    'botId. Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z
    .object({
      level: z.enum(['info', 'warn', 'error']).optional(),
      event: z.string().min(1).max(64).optional(),
      botId: botIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  async exec(_ctx, args) {
    const { level, event, botId, limit } = args as {
      level?: 'info' | 'warn' | 'error';
      event?: string;
      botId?: string;
      limit: number;
    };
    const rows = await db.log.findMany({
      where: {
        ...(level ? { level } : {}),
        ...(event ? { event } : {}),
        ...(botId ? { botId } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return {
      label: `Read ${rows.length} log row(s)`,
      data: {
        logs: rows.map((r) => ({
          at: r.timestamp.toISOString(),
          level: r.level,
          event: r.event,
          botId: r.botId,
          message: r.message.slice(0, 300),
        })),
      },
    };
  },
};

const platformSettingsGet: ToolSpec = {
  name: 'platform_settings_get',
  description:
    'Read the public site configuration: site name, tagline, support email, Telegram handle, ' +
    'welcome message. These feed the public landing page AND the official CS bot\\u2019s prompt. Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z.object({}).strict(),
  async exec() {
    const info = await getSiteInfo();
    return { label: 'Read site settings', data: info };
  },
};

const customersOverview: ToolSpec = {
  name: 'customers_overview',
  description:
    'The newest customers with plan, trial, wallet balance and bot count (top 20 + total). ' +
    'Read-only — use for "how many customers / who has a plan / who is out of credits".',
  kind: 'read',
  platformRequired: true,
  schema: z.object({}).strict(),
  async exec() {
    const [total, rows, botCounts] = await Promise.all([
      db.user.count(),
      db.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          email: true,
          name: true,
          emailVerified: true,
          planId: true,
          planExpiresAt: true,
          balanceMicros: true,
          trialEndsAt: true,
          createdAt: true,
        },
      }),
      db.bot.groupBy({ by: ['ownerId'], _count: { _all: true } }),
    ]);
    const countByOwner = new Map(botCounts.map((b) => [b.ownerId, b._count._all]));
    return {
      label: `Customers — ${total} total`,
      data: {
        total,
        customers: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          emailVerified: u.emailVerified,
          plan: u.planId && u.planExpiresAt && u.planExpiresAt > new Date() ? u.planId : null,
          balanceMicros: u.balanceMicros,
          onTrial: Boolean(u.trialEndsAt && u.trialEndsAt > new Date()),
          bots: countByOwner.get(u.id) ?? 0,
          joinedAt: u.createdAt.toISOString(),
        })),
      },
    };
  },
};

const botAnalytics: ToolSpec = {
  name: 'bot_analytics',
  description:
    'Engagement analytics. With botId: that bot\\u2019s conversations, total messages, 24h/7d ' +
    'messages, active users (7d), pending schedules, broadcast reach and Stars earned. Without ' +
    'botId: the busiest bots on the server (by conversations). Read-only.',
  kind: 'read',
  platformRequired: true,
  schema: z.object({ botId: botIdSchema.optional() }).strict(),
  async exec(_ctx, args) {
    const { botId } = args as { botId?: string };
    if (botId) {
      const bot = await anyBot(botId);
      if (!bot) return fail(`No bot with id ${botId} exists on this server.`);
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const conversations = await db.conversation.findMany({
        where: { botId },
        select: { id: true, chatId: true },
      });
      const conversationIds = conversations.map((c) => c.id);
      const [messagesAll, messages24h, messages7d, activeUsers, schedules, broadcasts, payments] =
        await Promise.all([
          db.message.count({ where: { conversationId: { in: conversationIds } } }),
          db.message.count({ where: { conversationId: { in: conversationIds }, timestamp: { gte: since24h } } }),
          db.message.count({ where: { conversationId: { in: conversationIds }, timestamp: { gte: since7d } } }),
          db.botUserState.count({ where: { botId, lastSeenAt: { gte: since7d } } }),
          db.botSchedule.count({ where: { botId, status: 'pending' } }),
          db.botBroadcast.findMany({ where: { botId }, orderBy: { createdAt: 'desc' }, take: 10 }),
          db.botPayment.findMany({ where: { botId }, select: { amount: true, currency: true } }),
        ]);
      return {
        label: `Analytics for "${bot.name}"`,
        data: {
          botId,
          name: bot.name,
          conversations: conversations.length,
          chats: conversations.filter((c) => c.chatId.startsWith('-')).length,
          messages: { total: messagesAll, last24h: messages24h, last7d: messages7d },
          activeUsers7d: activeUsers,
          schedulesPending: schedules,
          broadcasts: broadcasts.map((b) => ({ status: b.status, sent: b.sent, failed: b.failed, at: b.createdAt.toISOString() })),
          starsEarned: payments.filter((p) => p.currency === 'XTR').reduce((s, p) => s + p.amount, 0),
        },
      };
    }
    const top = await db.conversation.groupBy({
      by: ['botId'],
      _count: { _all: true },
      orderBy: { _count: { botId: 'desc' } },
      take: 8,
    });
    const named = await Promise.all(
      top.map(async (t) => {
        const b = await db.bot.findUnique({ where: { id: t.botId }, select: { name: true, ownerId: true } });
        return { botId: t.botId, name: b?.name ?? t.botId, ownedBy: b?.ownerId ? 'customer' : 'platform', conversations: t._count._all };
      }),
    );
    return {
      label: `Busiest bots — top ${named.length}`,
      data: { topBots: named, hint: 'Call again with a botId for one bot\\u2019s detailed analytics.' },
    };
  },
};

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

const fleetEnsure: ToolSpec = {
  name: 'fleet_ensure',
  description:
    'Idempotent, self-healing fleet pass: seeds missing official bots, re-creates vanished rows ' +
    '(tokens/keys of survivors preserved) and upgrades stale fleet templates in place. Safe to ' +
    'run anytime; no-ops when everything is current. Requires a resolvable site URL.',
  kind: 'write',
  platformRequired: true,
  schema: z.object({}).strict(),
  async exec() {
    const links = growthLinksFromEnv();
    if (!links) {
      return fail(
        'No site URL configured (NURAE_SITE_URL / NURAE_PUBLIC_URL) — fleet seeding is deferred ' +
          'until one exists (or load the admin dashboard, which seeds from the request origin).',
      );
    }
    const seeded = await ensureOfficialFleet(links);
    const fleet = await officialFleetStatus();
    return {
      label: seeded > 0 ? `Fleet pass created/upgraded ${seeded} bot(s)` : 'Fleet pass — everything already current',
      data: { created: seeded, fleet: fleet.map((f) => ({ name: f.name, botId: f.botId, ready: f.ready })) },
    };
  },
};

const fleetBotUpdate: ToolSpec = {
  name: 'fleet_bot_update',
  description:
    'Reconfigure ONE official fleet bot: AI provider/model, temperature, system prompt or ' +
    'description. Target by templateId (referral-ambassador | giveaway | daily-trivia | ' +
    'support-faq | community-hub | email-inviter) or botId. Fleet rows only \\u2014 customer bots ' +
    'are off-limits to the platform tier.',
  kind: 'write',
  platformRequired: true,
  schema: z
    .object({
      templateId: z.string().min(1).max(64).optional(),
      botId: botIdSchema.optional(),
      description: z.string().min(1).max(2000).optional(),
      systemPrompt: z.string().min(1).max(8000).optional(),
      provider: z.enum(['openai', 'openrouter', 'deepseek', 'glm', 'local', 'custom']).optional(),
      model: z.string().min(1).max(200).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .strict(),
  async exec(_ctx, args) {
    const { templateId, botId, ...patch } = args as {
      templateId?: string;
      botId?: string;
      description?: string;
      systemPrompt?: string;
      provider?: string;
      model?: string;
      temperature?: number;
    };
    if (Object.keys(patch).length === 0) return fail('Nothing to change — pass at least one field.');
    let row: Awaited<ReturnType<typeof anyBot>> = null;
    if (botId) {
      row = await anyBot(botId);
      if (!row) return fail(`No bot with id ${botId} exists on this server.`);
      if (row.ownerId) return fail(`"${row.name}" belongs to a customer — the platform tier cannot touch it.`);
    } else if (templateId) {
      const status = await officialFleetStatus();
      const entry = status.find((s) => s.templateId === templateId);
      if (!entry) return fail(`Unknown fleet template "${templateId}" — call fleet_status first.`);
      if (!entry.botId) return fail(`The "${entry.name}" fleet bot is not seeded yet — run fleet_ensure.`);
      row = await db.bot.findUnique({ where: { id: entry.botId } });
      if (!row) return fail(`The "${entry.name}" fleet bot row vanished — run fleet_ensure.`);
    } else {
      return fail('Target a fleet bot by templateId or botId.');
    }
    const updated = await db.bot.update({ where: { id: row.id }, data: patch });
    await db.log.create({
      data: {
        botId: updated.id,
        level: 'info',
        event: 'FLEET_BOT_UPDATED',
        message: `Operator agent updated fleet bot "${updated.name}" (fields: ${Object.keys(patch).join(', ')}).`,
      },
    });
    return {
      label: `Updated "${updated.name}" (${Object.keys(patch).join(', ')})`,
      data: { botId: updated.id, fields: Object.keys(patch) },
    };
  },
};

const platformSettingsSet: ToolSpec = {
  name: 'platform_settings_set',
  description:
    'Update the public site configuration (siteName, tagline, supportEmail, telegramHandle, ' +
    'welcomeMessage). Consequential: requires { confirm: true } AND the operator\\u2019s approval ' +
    'this turn \\u2014 the official CS bot\\u2019s prompt is rebuilt from these values.',
  kind: 'write',
  consequential: true,
  platformRequired: true,
  schema: z
    .object({
      siteName: z.string().trim().min(1).max(100).optional(),
      tagline: z.string().trim().min(1).max(300).optional(),
      supportEmail: z.string().trim().email().max(200).optional(),
      telegramHandle: z.string().trim().max(64).optional(),
      welcomeMessage: z.string().trim().min(1).max(1000).optional(),
      confirm: z.boolean(),
    })
    .strict(),
  async exec(ctx, args) {
    const { confirm, ...patch } = args as { confirm: boolean } & Record<string, string>;
    if (!confirm || !ctx.userConfirmed) {
      return {
        label: 'Waiting for operator approval to change site settings',
        status: 'confirm',
        data: { needsApproval: true, fields: Object.keys(patch) },
      };
    }
    await saveSiteInfo(patch);
    const info = await getSiteInfo();
    return {
      label: `Updated site settings (${Object.keys(patch).join(', ')})`,
      data: info,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PLATFORM_TOOLS: readonly ToolSpec[] = [
  platformOverview,
  botsListAll,
  platformBotGet,
  fleetStatus,
  platformLogs,
  platformSettingsGet,
  customersOverview,
  botAnalytics,
  fleetEnsure,
  fleetBotUpdate,
  platformSettingsSet,
];

export const PLATFORM_REGISTRY = new Map(PLATFORM_TOOLS.map((t) => [t.name, t]));

/** Descriptors for the operator agent's system prompt (and the admin UI). */
export function platformToolDescriptors() {
  return PLATFORM_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    kind: t.kind,
    consequential: Boolean(t.consequential),
  }));
}
