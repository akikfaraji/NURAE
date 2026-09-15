/**
 * NURAE — the agent tool layer (the "hands" of the system).
 *
 * This is the ONLY way agents touch the world. Agents never see the database,
 * the filesystem, or raw Prisma — they call named tools from this registry.
 *
 * Security model (non-negotiable):
 *  1. Identity: ToolContext.userId comes from the authenticated HTTP session
 *     on the request that drove the agent turn. It is NEVER taken from model
 *     output, request bodies, or URLs. An agent physically cannot pass a
 *     "user id" argument — the shape has no such field.
 *  2. Ownership: every bot/file lookup filters on ownerId = ctx.userId at the
 *     query level. Cross-user access is impossible by construction, not by
 *     checking afterwards.
 *  3. Read/write split: every tool declares `kind`. Clients and the agent
 *     loop can show/limit writes separately.
 *  4. Confirmation: consequential actions (publish, unpublish) require BOTH
 *     the model to pass `confirm: true` AND the human to have confirmed in
 *     this turn (ctx.userConfirmed — set by the API only when the user
 *     pressed the explicit approval control). One without the other fails.
 *  5. Validation: arguments are zod-validated before anything executes.
 *  6. Auditability: every invocation writes an AgentStep row (session-scoped,
 *     shown as user-facing progress) and a sanitized Log row (platform audit).
 *
 * MCP-compatibility: `toolDescriptors()` emits the registry as JSON-schema
 * tool definitions (the same envelope MCP servers advertise), so external
 * MCP clients can discover NURAE capabilities, and NURAE can later mount
 * external MCP servers behind the same ToolSpec interface.
 */

import { z } from 'zod';
import { db } from '@/lib/db';
import { sanitizeForLog, truncateForLog } from '../sanitize';
import {
  serializeCapabilities,
  type BotCapabilities,
} from '../bots/capabilities';
import { botBehaviorsSchema, describeWhen, type BotBehaviorSpec } from '../bots/behavior';
import {
  createUserBot,
  updateUserBot,
  listUserBots,
  getUserBot,
  userBotLifecycle,
} from '../bots/user-bots';
import { LIMITS } from '../validation';
import { SecretManager } from '../secrets';
import { TelegramAdapter } from '../telegram/adapter';
import { createPrismaRuntimeStore } from '../runtime/store';
import { buildTemplateBot, TEMPLATE_CATALOG, type GrowthLinks } from '../bots/templates';
import { growthLinksFromEnv } from '../bots/growth-links';
import { getOrCreateInvite } from '../referral';
import { AGENT_DOCS, DOCS_TOPICS, type DocsTopic } from './docs';
import { PLATFORM_REGISTRY } from './platform-tools';

// ---------------------------------------------------------------------------
// Context + result types
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Authenticated owner — derived from the session, never from the model. */
  userId: string;
  /** Agent session driving this invocation. */
  sessionId: string;
  /** True only when the user explicitly approved consequential actions THIS turn. */
  userConfirmed?: boolean;
  /**
   * Platform-operator scope. Set ONLY by the admin-authenticated operator
   * route — never from user sessions, model output, or request bodies.
   * Unlocks the platform tool tier (fleet, settings, customers, logs).
   */
  platform?: boolean;
  /** Request-resolved growth links — templates bake them at instantiation. */
  links?: GrowthLinks;
}

export interface ToolOutcome {
  /** Human-readable one-liner for the activity feed ("Created bot …"). */
  label: string;
  /** Extra human detail for the feed (optional). */
  detail?: string;
  /** Structured result fed back to the model (JSON-serializable). */
  data?: unknown;
  /** "ok" | "error" | "confirm" (waiting for user approval). */
  status?: 'ok' | 'error' | 'confirm';
}

export interface ToolSpec {
  name: string;
  description: string;
  kind: 'read' | 'write';
  /** Consequential action — the user must approve before it can run. */
  consequential?: boolean;
  /** Reserved for the platform operator (ctx.platform must be true). */
  platformRequired?: boolean;
  schema: z.ZodType<Record<string, unknown>>;
  exec(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const botIdSchema = z.string().min(1).max(64);

/** Owner-checked bot fetch — the single door to any bot row. */
async function ownedBot(ctx: ToolContext, botId: string) {
  return db.bot.findFirst({ where: { id: botId, ownerId: ctx.userId } });
}

function fail(label: string, data?: unknown): ToolOutcome {
  return { label, status: 'error', data };
}

// ---------------------------------------------------------------------------
// Bot tools
// ---------------------------------------------------------------------------

const botsList: ToolSpec = {
  name: 'bots_list',
  description:
    'List the current user\u2019s Telegram bots with id, name, status and capability counts. Read-only.',
  kind: 'read',
  schema: z.object({}).strict(),
  async exec(ctx) {
    const bots = await listUserBots(ctx.userId, { includeArchived: true });
    return {
      label: `Listed ${bots.length} bot(s)`,
      data: bots.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        status: b.status,
        enabled: b.enabled,
        archived: b.archived,
        telegramUsername: b.telegramUsername,
        hasTelegramToken: b.hasTelegramToken,
        hasApiKey: b.hasApiKey,
        provider: b.provider,
        model: b.model,
        commands: b.commands.length,
        replies: b.replies.length,
      })),
    };
  },
};

const botGet: ToolSpec = {
  name: 'bot_get',
  description:
    'Read one bot\u2019s full configuration (identity, AI settings, commands, replies/buttons). Read-only.',
  kind: 'read',
  schema: z.object({ botId: botIdSchema }).strict(),
  async exec(ctx, args) {
    const { botId } = z.object({ botId: botIdSchema }).parse(args);
    const bot = await getUserBot(ctx.userId, botId);
    if (!bot) return fail(`Bot not found (or not yours): ${botId}`);
    return {
      label: `Inspected bot "${bot.name}"`,
      data: {
        ...bot,
      },
    };
  },
};

const botCreateDraft: ToolSpec = {
  name: 'bot_create_draft',
  description:
    'Create a bot draft for the current user (name, description, system prompt, optional behaviors). ' +
    'Returns the new bot id. The bot is NOT live until published with a Telegram token.',
  kind: 'write',
  schema: z
    .object({
      name: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      systemPrompt: z.string().min(1).max(LIMITS.systemPromptMax).optional(),
      behaviors: z.array(z.record(z.string(), z.unknown())).max(40).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const result = await createUserBot(ctx.userId, args);
    if (result.error || !result.bot) {
      return fail('Bot draft rejected by validation', result.fields ?? result.error);
    }
    return {
      label: `Created bot "${result.bot.name}"`,
      detail: 'Draft saved \u2014 not live yet',
      data: { botId: result.bot.id, name: result.bot.name },
    };
  },
};

const botUpdate: ToolSpec = {
  name: 'bot_update',
  description:
    'Update an existing bot\u2019s identity or AI configuration (name, description, system prompt, provider, model, temperature, max tokens, memory).',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(2000).optional(),
      systemPrompt: z.string().min(1).max(LIMITS.systemPromptMax).optional(),
      provider: z.enum(['openai', 'openrouter', 'deepseek', 'glm', 'local', 'custom']).optional(),
      model: z.string().min(1).max(200).optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(100000).optional(),
      memorySize: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, ...patch } = z
      .object({
        botId: botIdSchema,
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
        systemPrompt: z.string().min(1).max(LIMITS.systemPromptMax).optional(),
        provider: z.enum(['openai', 'openrouter', 'deepseek', 'glm', 'local', 'custom']).optional(),
        model: z.string().min(1).max(200).optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(1).max(100000).optional(),
        memorySize: z.number().int().min(1).max(50).optional(),
      })
      .parse(args);
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const result = await updateUserBot(ctx.userId, botId, patch);
    if (result.error || !result.bot) return fail('Update rejected', result.fields ?? result.error);
    return { label: `Updated bot "${result.bot.name}"`, data: { botId: result.bot.id } };
  },
};

const botSetBehaviors: ToolSpec = {
  name: 'bot_set_behaviors',
  description:
    'THE primary way to configure what a bot does. Describe bot behavior in plain language; NURAE compiles ' +
    'commands, buttons, callbacks and flows automatically. Each behavior: { id (short slug), title, ' +
    'when: {type: "start"} | {type: "command", command: "/menu"} | {type: "says", text: "price"} | ' +
    '{type: "button"} (a press target) | {type: "anything_else"}, steps: [{type: "message", text, buttons?: ' +
    '[{label, action: {kind: "message", text} | {kind: "link", url} | {kind: "flow", behaviorId} | ' +
    '{kind: "ai", instruction?}]}] | [{type: "ai", instruction?}]}. Replaces the full behavior list; pass [] to clear. ' +
    'A "flow" button action starts ANOTHER behavior by id — create that behavior in the same call.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      behaviors: z.array(z.record(z.string(), z.unknown())).max(40),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, behaviors } = args as { botId: string; behaviors: unknown };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    let list: BotBehaviorSpec[];
    try {
      list = botBehaviorsSchema.parse(Array.isArray(behaviors) ? behaviors : []);
    } catch (err) {
      return fail(
        'Behaviors invalid',
        err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : String(err),
      );
    }
    const result = await updateUserBot(ctx.userId, botId, { behaviors: list });
    if (result.error || !result.bot) return fail('Behaviors rejected', result.fields ?? result.error);
    const summary = list.map((b) => `${describeWhen(b.when)} → ${b.title}`).join('; ').slice(0, 500);
    return {
      label:
        list.length === 0
          ? `Cleared behaviors on "${owned.name}"`
          : `Set ${list.length} behavior(s) on "${owned.name}"`,
      detail: summary || undefined,
      data: {
        botId,
        behaviors: list.length,
        list: list.map((b) => ({ id: b.id, title: b.title, when: b.when.type })),
      },
    };
  },
};

const botSetCommands: ToolSpec = {
  name: 'bot_set_commands',
  description:
    'ADVANCED (prefer bot_set_behaviors). Set a bot\u2019s raw menu commands (Telegram /commands). Each: ' +
    '{ command: "/name", description \u2264 64 chars, kind: "static"|"ai", response }. Replaces the full list; pass [] to clear. ' +
    'A later bot_set_behaviors call recompiles these.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      commands: z
        .array(
          z.object({
            command: z.string().regex(/^\/[a-zA-Z0-9_]{1,32}$/),
            description: z.string().min(1).max(64),
            kind: z.enum(['static', 'ai']).default('static'),
            response: z.string().max(4000).optional().default(''),
          }),
        )
        .max(20),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, commands } = args as { botId: string; commands: BotCapabilities['commands'] };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    try {
      const caps = serializeCapabilities({ commands });
      await db.bot.update({ where: { id: botId }, data: { commandsJson: caps.commandsJson } });
    } catch (err) {
      return fail(
        'Commands invalid',
        err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : String(err),
      );
    }
    return {
      label: `Set ${commands.length} command(s) on "${owned.name}"`,
      data: { botId, commands: commands.length },
    };
  },
};

const botSetReplies: ToolSpec = {
  name: 'bot_set_replies',
  description:
    'ADVANCED (prefer bot_set_behaviors). Set raw response rules: buttons, keyword answers and mini-workflows. ' +
    'Each reply: { id, name, trigger: {type: "command"|"keyword"|"button"|"fallback", value?}, ' +
    'messages: [{ text, buttons?: [[{ text, url?|callback? }]] }] }. Button callbacks must start with "r:". ' +
    'Replaces the full list; pass [] to clear. A later bot_set_behaviors call recompiles these.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      replies: z.array(z.record(z.string(), z.unknown())).max(30),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, replies } = args as { botId: string; replies: unknown };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    try {
      const caps = serializeCapabilities({ replies: replies as BotCapabilities['replies'] });
      await db.bot.update({ where: { id: botId }, data: { repliesJson: caps.repliesJson } });
    } catch (err) {
      return fail(
        'Replies invalid',
        err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : String(err),
      );
    }
    return {
      label: `Set response rules on "${owned.name}"`,
      data: { botId, replies: Array.isArray(replies) ? replies.length : 0 },
    };
  },
};

const botAddKnowledge: ToolSpec = {
  name: 'bot_add_knowledge',
  description:
    'Append concise knowledge (e.g. distilled from an uploaded document) to a bot\u2019s system prompt. ' +
    'Keep it under 3000 chars \u2014 it is stored inside the prompt, not a vector store.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      knowledge: z.string().min(1).max(3000),
      topic: z.string().max(100).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, knowledge, topic } = args as { botId: string; knowledge: string; topic?: string };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const appendix = `\n\n## Knowledge${topic ? ` \u2014 ${topic}` : ''}\n${knowledge.trim()}`;
    const merged = `${owned.systemPrompt}${appendix}`.slice(0, LIMITS.systemPromptMax);
    await db.bot.update({ where: { id: botId }, data: { systemPrompt: merged } });
    return { label: `Added knowledge to "${owned.name}"`, data: { botId, promptLength: merged.length } };
  },
};

const botPublish: ToolSpec = {
  name: 'bot_publish',
  description:
    'Put a bot live on Telegram (enables it and registers the webhook/polling). Consequential: requires ' +
    '{ confirm: true } AND the user\u2019s explicit approval in this turn. The bot needs a Telegram token first.',
  kind: 'write',
  consequential: true,
  schema: z
    .object({
      botId: botIdSchema,
      confirm: z.boolean(),
      /** Public HTTPS origin for the webhook (set automatically by NURAE). */
      publicBaseUrl: z.string().max(300).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, confirm, publicBaseUrl } = args as {
      botId: string;
      confirm: boolean;
      publicBaseUrl?: string;
    };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    if (!confirm || !ctx.userConfirmed) {
      return {
        label: `Waiting for your approval to publish "${owned.name}"`,
        status: 'confirm',
        data: { botId, needsApproval: true },
      };
    }
    const result = await userBotLifecycle(ctx.userId, botId, 'start', publicBaseUrl ?? null);
    if (!result.ok) return fail(`Could not publish "${owned.name}": ${result.error}`);
    await db.bot.update({ where: { id: botId }, data: { enabled: true } });
    return {
      label: `Published "${owned.name}" \u2014 live on Telegram`,
      data: { botId, status: result.status },
    };
  },
};

const botUnpublish: ToolSpec = {
  name: 'bot_unpublish',
  description:
    'Take a bot offline (stops the runtime and disables it). Consequential: requires { confirm: true } AND ' +
    'the user\u2019s explicit approval in this turn.',
  kind: 'write',
  consequential: true,
  schema: z.object({ botId: botIdSchema, confirm: z.boolean() }).strict(),
  async exec(ctx, args) {
    const { botId, confirm } = args as { botId: string; confirm: boolean };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    if (!confirm || !ctx.userConfirmed) {
      return {
        label: `Waiting for your approval to unpublish "${owned.name}"`,
        status: 'confirm',
        data: { botId, needsApproval: true },
      };
    }
    const result = await userBotLifecycle(ctx.userId, botId, 'stop', null);
    if (!result.ok) return fail(`Could not stop "${owned.name}": ${result.error}`);
    await db.bot.update({ where: { id: botId }, data: { enabled: false } });
    return { label: `Unpublished "${owned.name}"`, data: { botId } };
  },
};

// ---------------------------------------------------------------------------
// Ecosystem tools — profile, audience, broadcast, schedule, payments
// ---------------------------------------------------------------------------

const botSetProfile: ToolSpec = {
  name: 'bot_set_profile',
  description:
    'Set the bot\u2019s PUBLIC profile text on Telegram: what it does before anyone starts it. ' +
    'description = the "What can this bot do?" line (\u2264512 chars, shown before /start); ' +
    'shortDescription = the profile bio (\u2264120 chars); name = display name (\u226464). ' +
    'Requires a Telegram token (not necessarily live). One strong sentence each — no keyword soup.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      description: z.string().min(1).max(512).optional(),
      shortDescription: z.string().min(1).max(120).optional(),
      name: z.string().min(1).max(64).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, description, shortDescription, name } = args as {
      botId: string;
      description?: string;
      shortDescription?: string;
      name?: string;
    };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    if (!owned.telegramTokenRef) {
      return fail(`"${owned.name}" has no Telegram token yet — add it before setting the Telegram profile.`);
    }
    let token: string;
    try {
      token = SecretManager.decrypt(owned.telegramTokenRef);
    } catch {
      return fail('Stored Telegram token could not be decrypted. Re-enter the token.');
    }
    const adapter = new TelegramAdapter({ token });
    const applied: string[] = [];
    try {
      if (description) {
        await adapter.setMyDescription(description);
        applied.push('description');
      }
      if (shortDescription) {
        await adapter.setMyShortDescription(shortDescription);
        applied.push('short description');
      }
      if (name) {
        await adapter.setMyName(name);
        applied.push('name');
      }
    } catch (err) {
      return fail(`Telegram rejected the profile update: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      label: `Updated ${applied.join(' + ')} on "${owned.name}"`,
      data: { botId, applied },
    };
  },
};

const botListUsers: ToolSpec = {
  name: 'bot_list_users',
  description:
    'List a bot\u2019s audience: every chat that ever talked to it, with stored attributes (collected answers, ' +
    'carts, arrival payload) and last-seen time. Read-only — use it to personalize flows or report reach.',
  kind: 'read',
  schema: z.object({ botId: botIdSchema }).strict(),
  async exec(ctx, args) {
    const { botId } = args as { botId: string };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const store = createPrismaRuntimeStore(db);
    const chats = await store.listChatIds(botId);
    const users: Array<{ chatId: string; attributes: Record<string, string>; startPayload: string | null }> = [];
    for (const chatId of chats.slice(0, 200)) {
      const state = await store.getUserState(botId, chatId);
      users.push({
        chatId,
        attributes: state?.attributes ?? {},
        startPayload: state?.startPayload ?? null,
      });
    }
    return { label: `Listed ${users.length} chat(s) for "${owned.name}"`, data: { botId, users } };
  },
};

const botBroadcast: ToolSpec = {
  name: 'bot_broadcast',
  description:
    'Send ONE message to every chat the bot has ever talked to (newsletters, announcements). Consequential: ' +
    'requires { confirm: true } AND the user\u2019s approval this turn. Delivery is queued and paced (~20 msg/s); ' +
    'results appear in the bot\u2019s broadcasts list. Markdown renders. Use sparingly — nobody likes spam.',
  kind: 'write',
  consequential: true,
  schema: z
    .object({
      botId: botIdSchema,
      text: z.string().min(1).max(4000),
      confirm: z.boolean(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, text, confirm } = args as { botId: string; text: string; confirm: boolean };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    if (!confirm || !ctx.userConfirmed) {
      return {
        label: `Waiting for your approval to broadcast to "${owned.name}"\u2019s audience`,
        status: 'confirm',
        data: { botId, needsApproval: true },
      };
    }
    if (!owned.telegramTokenRef) {
      return fail(`"${owned.name}" has no Telegram token — a broadcast needs a live bot.`);
    }
    const store = createPrismaRuntimeStore(db);
    const chats = await store.listChatIds(botId);
    if (!chats.length) {
      return fail('No one has talked to this bot yet — there is nobody to broadcast to.');
    }
    const row = await store.createBroadcast(botId, text, chats.length);
    return {
      label: `Broadcast queued to ${chats.length} chat(s) of "${owned.name}"`,
      detail: 'Delivery runs in the background at ~20 messages/second.',
      data: { botId, broadcastId: row.id, recipients: chats.length, status: row.status },
    };
  },
};

const botScheduleMessage: ToolSpec = {
  name: 'bot_schedule_message',
  description:
    'Schedule a message to ONE chat (reminders, drip content). Args: botId, chatId, text, and either ' +
    'runAt (ISO 8601, UTC) or inMinutes (number); recurrence: "once" (default) | "daily" | "weekly". ' +
    'Or cancel with cancelScheduleId. Max one year ahead. The bot must have a Telegram token.',
  kind: 'write',
  schema: z
    .object({
      botId: botIdSchema,
      chatId: z.string().min(1).max(64).optional(),
      text: z.string().min(1).max(4000).optional(),
      runAt: z.string().max(40).optional(),
      inMinutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
      recurrence: z.enum(['once', 'daily', 'weekly']).default('once'),
      cancelScheduleId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { botId, chatId, text, runAt, inMinutes, recurrence, cancelScheduleId } = args as {
      botId: string;
      chatId?: string;
      text?: string;
      runAt?: string;
      inMinutes?: number;
      recurrence: 'once' | 'daily' | 'weekly';
      cancelScheduleId?: string;
    };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const store = createPrismaRuntimeStore(db);
    if (cancelScheduleId) {
      const ok = await store.cancelSchedule(botId, cancelScheduleId);
      if (!ok) return fail(`Schedule ${cancelScheduleId} not found (or already sent/cancelled).`);
      return { label: `Cancelled a scheduled message on "${owned.name}"`, data: { botId, cancelled: cancelScheduleId } };
    }
    if (!chatId || !text) return fail('Scheduling needs chatId and text (or cancelScheduleId to cancel).');
    if (!owned.telegramTokenRef) {
      return fail(`"${owned.name}" has no Telegram token — scheduled sends need one.`);
    }
    let runDate: Date;
    if (inMinutes !== undefined) {
      runDate = new Date(Date.now() + inMinutes * 60_000);
    } else if (runAt) {
      runDate = new Date(runAt);
      if (Number.isNaN(runDate.getTime())) return fail(`"${runAt}" is not a valid ISO 8601 datetime.`);
    } else {
      return fail('Give runAt (ISO 8601) or inMinutes.');
    }
    if (runDate.getTime() <= Date.now()) return fail('That time is in the past.');
    if (runDate.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) return fail('Schedules can be at most one year ahead.');
    const row = await store.createSchedule({ botId, chatId, text, runAt: runDate, recurrence });
    return {
      label: `Scheduled a ${recurrence === 'once' ? 'one-time' : recurrence} message for "${owned.name}"`,
      detail: `Runs at ${row.runAt.toISOString().replace('T', ' ').slice(0, 16)} UTC → chat ${chatId}`,
      data: { botId, scheduleId: row.id, runAt: row.runAt.toISOString(), recurrence },
    };
  },
};

const botListSchedules: ToolSpec = {
  name: 'bot_list_schedules',
  description:
    'List a bot\u2019s pending/failed scheduled messages (id, chat, run time, recurrence, first line of text). ' +
    'Cancel with bot_schedule_message { cancelScheduleId }. Read-only.',
  kind: 'read',
  schema: z.object({ botId: botIdSchema }).strict(),
  async exec(ctx, args) {
    const { botId } = args as { botId: string };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const store = createPrismaRuntimeStore(db);
    const rows = await store.listSchedules(botId);
    return {
      label: `Listed ${rows.length} schedule(s) for "${owned.name}"`,
      data: {
        botId,
        schedules: rows.map((r) => ({
          id: r.id,
          chatId: r.chatId,
          runAt: r.runAt.toISOString(),
          recurrence: r.recurrence,
          status: r.status,
          textPreview: r.text.slice(0, 120),
        })),
      },
    };
  },
};

const botPaymentsList: ToolSpec = {
  name: 'bot_payments_list',
  description:
    'List a bot\u2019s completed Telegram Stars payments (amount, chat, product payload, date). Read-only. ' +
    'Refunds are manual this release — say so honestly if asked.',
  kind: 'read',
  schema: z.object({ botId: botIdSchema }).strict(),
  async exec(ctx, args) {
    const { botId } = args as { botId: string };
    const owned = await ownedBot(ctx, botId);
    if (!owned) return fail(`Bot not found (or not yours): ${botId}`);
    const store = createPrismaRuntimeStore(db);
    const rows = await store.listPayments(botId);
    const totalStars = rows.reduce((sum, r) => sum + (r.currency === 'XTR' ? r.amount : 0), 0);
    return {
      label: `Listed ${rows.length} payment(s) for "${owned.name}"`,
      data: {
        botId,
        totalStars,
        payments: rows.map((r) => ({
          chatId: r.chatId,
          amount: r.amount,
          currency: r.currency,
          payload: r.payload,
          title: r.title,
          at: r.createdAt.toISOString(),
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Knowledge tools — the agent reads the real DSL instead of guessing
// ---------------------------------------------------------------------------

const docsRead: ToolSpec = {
  name: 'docs_read',
  description:
    'Read NURAE\u2019s agent documentation. Topics: "behaviors" (the FULL behavior DSL \u2014 every trigger ' +
    'and step with exact argument shapes), "growth" (join gates, streaks, milestones, draws, ' +
    'leaderboards, referral deep links, email invites), "billing" (what running bots costs), ' +
    '"lifecycle" (draft \u2192 token \u2192 publish \u2192 profile). Read a topic BEFORE building flows that need it ' +
    '(a giveaway needs verify_join; an invite funnel needs email_invite; a habit bot needs streak). Read-only.',
  kind: 'read',
  schema: z.object({ topic: z.enum(['behaviors', 'growth', 'billing', 'lifecycle']) }).strict(),
  async exec(_ctx, args) {
    const { topic } = args as { topic: DocsTopic };
    return {
      label: `Read the "${topic}" reference`,
      data: { topic, text: AGENT_DOCS[topic] },
    };
  },
};

const templateList: ToolSpec = {
  name: 'template_list',
  description:
    'List the built-in NURAE bot templates ready to instantiate (giveaway, daily trivia, referral ' +
    'ambassador, support & FAQ, community hub, email inviter) with id, tagline, category and ' +
    'highlights. Read-only.',
  kind: 'read',
  schema: z.object({}).strict(),
  async exec() {
    return {
      label: `Listed ${TEMPLATE_CATALOG.length} template(s)`,
      data: TEMPLATE_CATALOG.map((t) => ({
        id: t.id,
        name: t.name,
        tagline: t.tagline,
        category: t.category,
        highlights: t.highlights,
      })),
    };
  },
};

const templateUse: ToolSpec = {
  name: 'template_use',
  description:
    'Instantiate a built-in template (template_list) as the user\u2019s OWN new bot, with the user\u2019s ' +
    'personal referral link baked in (they earn premium days when their audience signs up). Args: ' +
    'templateId, optional name override. The bot arrives fully configured (behaviors, prompt) and ' +
    'stays owner-editable \u2014 refine it with bot_set_behaviors afterwards. Draft, not live.',
  kind: 'write',
  schema: z
    .object({
      templateId: z.string().min(1).max(64),
      name: z.string().min(1).max(100).optional(),
    })
    .strict(),
  async exec(ctx, args) {
    const { templateId, name } = args as { templateId: string; name?: string };
    const links = ctx.links ?? growthLinksFromEnv();
    if (!links) {
      return fail(
        'No site URL is configured on this server (NURAE_SITE_URL / NURAE_PUBLIC_URL), so the ' +
          'template\u2019s NURAE growth links cannot be baked. Ask the site owner to set it.',
      );
    }
    const built = buildTemplateBot(templateId, links, (await getOrCreateInvite(ctx.userId)).code);
    if (!built) {
      return fail(`Unknown template "${templateId}" \u2014 call template_list for the catalog.`);
    }
    const result = await createUserBot(ctx.userId, {
      name: name?.trim() || built.name,
      description: built.description,
      systemPrompt: built.systemPrompt,
      behaviors: built.behaviors,
    });
    if (result.error || !result.bot) {
      return fail('Template instantiation rejected by validation', result.fields ?? result.error);
    }
    return {
      label: `Created "${result.bot.name}" from the ${templateId} template`,
      detail: 'Draft saved \u2014 refine with bot_set_behaviors, then publish',
      data: { botId: result.bot.id, name: result.bot.name, behaviors: built.behaviors.length },
    };
  },
};

const filesList: ToolSpec = {
  name: 'files_list',
  description:
    'List files available for this task: everything the user attached in this agent session AND files attached in the chat that started it (name, kind, fileId — read them with files_read). Read-only.',
  kind: 'read',
  schema: z.object({}).strict(),
  async exec(ctx) {
    const rows = await db.userFile.findMany({
      where: { sessionId: ctx.sessionId, userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, kind: true, status: true, size: true },
    });
    // Files attached in the ORIGINATING chat travel with the handoff (session
    // state fileRefs). They are stored against the chat session id, so the
    // plain sessionId query cannot see them — union them in, still
    // ownership-checked by files_read and the state itself.
    const session = await db.chatSession.findUnique({
      where: { id: ctx.sessionId },
      select: { state: true },
    });
    let refs: Array<{ fileId: string; name: string }> = [];
    if (session?.state) {
      try {
        const parsed = JSON.parse(session.state) as { fileRefs?: Array<{ fileId: string; name: string }> };
        refs = Array.isArray(parsed.fileRefs) ? parsed.fileRefs.slice(0, 8) : [];
      } catch {
        /* corrupt state → no extras */
      }
    }
    const seen = new Set(rows.map((r) => r.id));
    const extras = refs
      .filter((r) => !seen.has(r.fileId))
      .map((r) => ({ id: r.fileId, name: r.name, kind: 'chat attachment', status: 'ready', size: null }));
    const all = [...rows, ...extras];
    return { label: `Listed ${all.length} file(s)`, data: all };
  },
};

const filesRead: ToolSpec = {
  name: 'files_read',
  description:
    'Read extracted text from one of the user\u2019s files (slice by offset). Binary/unreadable files report honestly.',
  kind: 'read',
  schema: z
    .object({
      fileId: z.string().min(1).max(64),
      offset: z.number().int().min(0).max(1_000_000).default(0),
      length: z.number().int().min(200).max(20_000).default(8000),
    })
    .strict(),
  async exec(ctx, args) {
    const { fileId, offset, length } = args as { fileId: string; offset: number; length: number };
    const row = await db.userFile.findFirst({
      where: { id: fileId, userId: ctx.userId },
      select: { id: true, name: true, kind: true, status: true, extractedText: true },
    });
    if (!row) return fail(`File not found (or not yours): ${fileId}`);
    const text = row.extractedText ?? '';
    if (!text) {
      return {
        label: `File "${row.name}" has no extractable text (${row.kind})`,
        status: 'error',
        data: { fileId, status: row.status },
      };
    }
    const slice = text.slice(offset, offset + length);
    return {
      label: `Read ${slice.length} chars from "${row.name}"`,
      data: {
        fileId,
        name: row.name,
        kind: row.kind,
        totalChars: text.length,
        offset,
        hasMore: offset + length < text.length,
        text: slice,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS: readonly ToolSpec[] = [
  botsList,
  botGet,
  botCreateDraft,
  botUpdate,
  botSetBehaviors,
  botSetCommands,
  botSetReplies,
  botAddKnowledge,
  botSetProfile,
  botListUsers,
  botBroadcast,
  botScheduleMessage,
  botListSchedules,
  botPaymentsList,
  botPublish,
  botUnpublish,
  filesList,
  filesRead,
  docsRead,
  templateList,
  templateUse,
];

const REGISTRY = new Map(TOOLS.map((t) => [t.name, t]));

export { DOCS_TOPICS };

/**
 * Tool lookup across BOTH tiers: the per-user registry and the platform
 * operator registry (whose specs are platformRequired and stay locked until
 * an operator-scoped context shows up).
 */
export function getTool(name: string): ToolSpec | undefined {
  return REGISTRY.get(name) ?? PLATFORM_REGISTRY.get(name);
}

/** JSON-schema descriptors (MCP-compatible advertisement of capabilities). */
export function toolDescriptors() {
  return TOOLS.map((t) => {
    let parameters: Record<string, unknown> = { type: 'object', properties: {} };
    try {
      // zod v4 ships z.toJSONSchema — use it when available.
      const zod4 = z as unknown as { toJSONSchema?: (s: unknown, o?: unknown) => Record<string, unknown> };
      if (typeof zod4.toJSONSchema === 'function') {
        parameters = zod4.toJSONSchema(t.schema, { io: 'input' });
      }
    } catch {
      /* keep the empty object schema */
    }
    return {
      name: t.name,
      description: t.description,
      kind: t.kind,
      consequential: Boolean(t.consequential),
      inputSchema: parameters,
    };
  });
}

// ---------------------------------------------------------------------------
// Execution + audit
// ---------------------------------------------------------------------------

export interface ExecRecord {
  seq: number;
  tool: string;
  label: string;
  status: 'ok' | 'error' | 'confirm';
  detail?: string;
  /** Structured result for the model's next round (compact — large payloads trimmed). */
  data?: unknown;
}

/**
 * Validate + execute one tool call with full auditing. Never throws —
 * failures come back as structured outcomes so a broken tool call can never
 * crash an agent turn.
 */
export async function executeTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: unknown,
  seq: number,
): Promise<ExecRecord> {
  const tool = REGISTRY.get(toolName) ?? PLATFORM_REGISTRY.get(toolName);
  if (!tool) {
    return { seq, tool: toolName, label: `Unknown tool "${toolName}"`, status: 'error' };
  }
  if (tool.platformRequired && !ctx.platform) {
    return {
      seq,
      tool: toolName,
      label: `"${toolName}" is reserved for the platform operator`,
      status: 'error',
    };
  }
  let outcome: ToolOutcome;
  try {
    const args = tool.schema.parse(rawArgs ?? {}) as Record<string, unknown>;
    outcome = await tool.exec(ctx, args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      outcome = {
        label: `Invalid arguments for ${toolName}`,
        status: 'error',
        data: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    } else {
      outcome = { label: `Tool ${toolName} failed`, status: 'error', data: String(err) };
    }
  }

  const status = outcome.status ?? 'ok';
  // Session-scoped activity record (user-facing progress).
  await db.agentStep
    .create({
      data: {
        sessionId: ctx.sessionId,
        seq,
        tool: toolName,
        argsJson: truncateForLog(JSON.stringify(rawArgs ?? {}), 2000),
        resultJson: outcome.data !== undefined ? truncateForLog(JSON.stringify(outcome.data), 4000) : null,
        status,
        label: sanitizeForLog(outcome.label).slice(0, 200),
      },
    })
    .catch(() => undefined);
  // Platform audit log (sanitized).
  await db.log
    .create({
      data: {
        botId: null,
        level: status === 'error' ? 'warn' : 'info',
        event: 'AGENT_TOOL',
        message: truncateForLog(
          `session=${ctx.sessionId} tool=${toolName} kind=${tool.kind} status=${status} \u2014 ${outcome.label}`,
        ),
      },
    })
    .catch(() => undefined);

  return {
    seq,
    tool: toolName,
    label: outcome.label,
    status,
    detail: outcome.detail,
    data: outcome.data !== undefined ? compactData(outcome.data) : undefined,
  };
}

/** Tool data feeds the model's next round — keep it useful but bounded. */
function compactData(data: unknown): unknown {
  try {
    const json = JSON.stringify(data);
    if (json.length <= 4000) return data;
    return { truncated: json.slice(0, 4000) };
  } catch {
    return undefined;
  }
}
