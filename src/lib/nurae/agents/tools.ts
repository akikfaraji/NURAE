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
import {
  createUserBot,
  updateUserBot,
  listUserBots,
  getUserBot,
  userBotLifecycle,
} from '../bots/user-bots';
import { LIMITS } from '../validation';

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
    'Create a bot draft for the current user (name, description, system prompt, optional commands/replies). ' +
    'Returns the new bot id. The bot is NOT live until published with a Telegram token.',
  kind: 'write',
  schema: z
    .object({
      name: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      systemPrompt: z.string().min(1).max(LIMITS.systemPromptMax).optional(),
      commands: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
      replies: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
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

const botSetCommands: ToolSpec = {
  name: 'bot_set_commands',
  description:
    'Set a bot\u2019s menu commands (Telegram /commands). Each: { command: "/name", description \u2264 64 chars, ' +
    'kind: "static"|"ai", response }. Replaces the full list; pass [] to clear.',
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
    'Set a bot\u2019s response rules: buttons, keyword answers and mini-workflows. Each reply: ' +
    '{ id, name, trigger: {type: "command"|"keyword"|"button"|"fallback", value?}, ' +
    'messages: [{ text, buttons?: [[{ text, url?|callback? }]] }] }. Button callbacks must start with "r:". ' +
    'Replaces the full list; pass [] to clear.',
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
// File tools
// ---------------------------------------------------------------------------

const filesList: ToolSpec = {
  name: 'files_list',
  description:
    'List files the user attached in this session (name, kind, whether text was extractable). Read-only.',
  kind: 'read',
  schema: z.object({}).strict(),
  async exec(ctx) {
    const rows = await db.userFile.findMany({
      where: { sessionId: ctx.sessionId, userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, kind: true, status: true, size: true },
    });
    return { label: `Listed ${rows.length} file(s)`, data: rows };
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
  botSetCommands,
  botSetReplies,
  botAddKnowledge,
  botPublish,
  botUnpublish,
  filesList,
  filesRead,
];

const REGISTRY = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolSpec | undefined {
  return REGISTRY.get(name);
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
  const tool = REGISTRY.get(toolName);
  if (!tool) {
    return { seq, tool: toolName, label: `Unknown tool "${toolName}"`, status: 'error' };
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
  };
}
