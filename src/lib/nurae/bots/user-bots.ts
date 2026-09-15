/**
 * NURAE — user-owned bots.
 *
 * The structural change in this release: bots used to belong to the single
 * admin. Now every customer owns their bots (`Bot.ownerId = session user`).
 * EVERY query below takes the userId from the authenticated execution
 * context and filters on it — a user id can never arrive from a client, a
 * model, or a URL and be trusted.
 *
 * Also hosts the TEST CONSOLE: a real pipeline turn against a capturing
 * fake sender — the same `handleBotMessage` the webhook runs, including the
 * bot's real AI provider — so owners can exercise a bot without Telegram.
 */

import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, toBotDTO, type BotDTO } from '@/lib/nurae/api/base';
import { SecretManager } from '../secrets';
import { createBotSchema, updateBotConfigSchema, LIMITS, formatZodError } from '../validation';
import {
  loadCapabilities,
  serializeCapabilities,
  type BotCapabilities,
} from './capabilities';
import {
  BehaviorCompileError,
  compileBehaviors,
  loadBehaviors,
  serializeBehaviors,
  type BotBehaviorSpec,
} from './behavior';
import { createPrismaRuntimeStore, type RuntimeBotRecord } from '../runtime/store';
import {
  handleBotMessage,
  handleBotCallback,
  capturingSender,
  type CapturedSend,
} from '../runtime/pipeline';

// ---------------------------------------------------------------------------
// Project shim — bots live in a project; users get one automatically
// ---------------------------------------------------------------------------

export const USER_PROJECT_NAME = 'My Bots';

export async function ensureUserProject(userId: string): Promise<string> {
  const existing = await db.project.findFirst({
    where: { name: USER_PROJECT_NAME, description: { contains: userId } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const project = await db.project.create({
    data: {
      name: USER_PROJECT_NAME,
      description: `Personal bot workspace (${userId})`,
    },
  });
  return project.id;
}

// ---------------------------------------------------------------------------
// DTO — everything the user is allowed to see (secrets stay out)
// ---------------------------------------------------------------------------

export interface UserBotDTO extends BotDTO {
  ownerId: string | null;
  archived: boolean;
  commands: BotCapabilities['commands'];
  replies: BotCapabilities['replies'];
  behaviors: BotBehaviorSpec[];
}

type BotRowFull = {
  id: string;
  projectId: string;
  ownerId: string | null;
  name: string;
  description: string;
  telegramUsername: string | null;
  telegramTokenRef: string | null;
  apiKeyRef: string | null;
  baseUrl: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  commandsJson: string | null;
  repliesJson: string | null;
  behaviorsJson: string | null;
  archived: boolean;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  transport: string | null;
  ownerChatId: string | null;
  lastStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toUserBotDTO(row: BotRowFull): UserBotDTO {
  const caps = loadCapabilities(row);
  return {
    ...toBotDTO(row),
    ownerId: row.ownerId,
    archived: row.archived,
    commands: caps.commands,
    replies: caps.replies,
    behaviors: loadBehaviors(row),
  };
}

// ---------------------------------------------------------------------------
// Queries — ownership enforced at every door
// ---------------------------------------------------------------------------

export async function listUserBots(userId: string, opts?: { includeArchived?: boolean }) {
  const rows = await db.bot.findMany({
    where: { ownerId: userId, ...(opts?.includeArchived ? {} : { archived: false }) },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toUserBotDTO);
}

export async function getUserBot(userId: string, botId: string): Promise<UserBotDTO | null> {
  const row = await db.bot.findFirst({ where: { id: botId, ownerId: userId } });
  return row ? toUserBotDTO(row) : null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateUserBotInput {
  name: string;
  description?: string;
  telegramToken?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  memorySize?: number;
  apiKey?: string;
  baseUrl?: string;
  commands?: BotCapabilities['commands'];
  replies?: BotCapabilities['replies'];
  behaviors?: BotBehaviorSpec[];
}

/**
 * Draft-friendly create: unlike the admin path, the Telegram token and AI
 * key are OPTIONAL — an agent (or a human) can stage a bot before wiring
 * credentials. Starting without a token is refused at lifecycle time.
 */
export async function createUserBot(
  userId: string,
  input: unknown,
): Promise<{ bot?: UserBotDTO; error?: string; fields?: Record<string, string> }> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const schema = createBotSchema;
  // createBotSchema demands a token; relax just that one requirement here
  // (lifecycle re-refuses to start without one). Everything else is unchanged.
  const parsed = schema.safeParse({
    provider: 'openrouter',
    model: 'openrouter/free',
    systemPrompt:
      'You are a helpful assistant. Answer clearly and concisely in the bot owner\u2019s language.',
    temperature: 0.7,
    maxTokens: 1024,
    memorySize: 10,
    ...raw,
    telegramToken:
      typeof raw.telegramToken === 'string' && raw.telegramToken.trim()
        ? raw.telegramToken.trim()
        : '000000:draftBotNoToken00000000000000000',
  });
  if (!parsed.success) {
    return { error: 'Validation failed', fields: formatZodError(parsed.error) };
  }
  const data = parsed.data;
  let caps: { commandsJson: string | null; repliesJson: string | null };
  let behaviorsJson: string | null = null;
  try {
    caps = serializeCapabilities({
      commands: Array.isArray(raw.commands) ? (raw.commands as BotCapabilities['commands']) : undefined,
      replies: Array.isArray(raw.replies) ? (raw.replies as BotCapabilities['replies']) : undefined,
    });
    // Behaviors are the source of truth: when present they compile into the
    // executed configuration (replacing any commands/replies passed along).
    if (Array.isArray(raw.behaviors) && raw.behaviors.length) {
      const compiled = compileBehaviors(raw.behaviors as BotBehaviorSpec[]);
      const merged = serializeCapabilities({
        commands: [...compiled.commands, ...(Array.isArray(raw.commands) ? (raw.commands as BotCapabilities['commands']) : [])],
        replies: compiled.replies,
      });
      caps = merged;
      behaviorsJson = serializeBehaviors(raw.behaviors as BotBehaviorSpec[]);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { error: 'Validation failed', fields: formatZodError(err) };
    }
    if (err instanceof BehaviorCompileError) {
      return { error: err.issues.join(' '), fields: { behaviors: err.issues.join(' ') } };
    }
    throw err;
  }
  const projectId = await ensureUserProject(userId);
  const row = await db.bot.create({
    data: {
      projectId,
      ownerId: userId,
      name: data.name,
      description: data.description ?? '',
      telegramTokenRef: typeof raw.telegramToken === 'string' && raw.telegramToken.trim()
        ? SecretManager.encrypt(raw.telegramToken.trim())
        : null,
      apiKeyRef: data.apiKey ? SecretManager.encrypt(data.apiKey) : null,
      baseUrl: data.baseUrl || null,
      systemPrompt: data.systemPrompt,
      provider: data.provider,
      model: data.model,
      temperature: data.temperature,
      maxTokens: data.maxTokens,
      memorySize: data.memorySize,
      commandsJson: caps.commandsJson,
      repliesJson: caps.repliesJson,
      behaviorsJson,
    },
  });
  await db.log.create({
    data: {
      botId: row.id,
      level: 'info',
      event: 'BOT_CREATED',
      message: `User bot "${row.name}" created (owner: ${userId}).`,
    },
  });
  return { bot: toUserBotDTO({ ...row, telegramTokenRef: row.telegramTokenRef, apiKeyRef: row.apiKeyRef }) };
}

export interface UpdateUserBotInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  memorySize?: number;
  enabled?: boolean;
  archived?: boolean;
  telegramToken?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Owner's own Telegram chat id for instant alerts ('' clears). */
  ownerChatId?: string;
  commands?: BotCapabilities['commands'];
  replies?: BotCapabilities['replies'];
  behaviors?: BotBehaviorSpec[];
}

export async function updateUserBot(
  userId: string,
  botId: string,
  input: unknown,
): Promise<{ bot?: UserBotDTO; error?: string; fields?: Record<string, string> }> {
  const existing = await db.bot.findFirst({ where: { id: botId, ownerId: userId } });
  if (!existing) return { error: 'Bot not found' };

  const parsed = updateBotConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { error: 'Validation failed', fields: formatZodError(parsed.error) };
  }
  const data = parsed.data;
  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.systemPrompt !== undefined) patch.systemPrompt = data.systemPrompt;
  if (data.provider !== undefined) patch.provider = data.provider;
  if (data.model !== undefined) patch.model = data.model;
  if (data.temperature !== undefined) patch.temperature = data.temperature;
  if (data.maxTokens !== undefined) patch.maxTokens = data.maxTokens;
  if (data.memorySize !== undefined) patch.memorySize = data.memorySize;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  // Instant-owner-alerts wiring: '' clears it, digits set it.
  if (data.ownerChatId !== undefined) patch.ownerChatId = data.ownerChatId ? data.ownerChatId : null;
  if (typeof (input as UpdateUserBotInput).archived === 'boolean') {
    patch.archived = (input as UpdateUserBotInput).archived;
  }
  if (data.telegramToken) patch.telegramTokenRef = SecretManager.encrypt(data.telegramToken);
  if (data.apiKey !== undefined) {
    patch.apiKeyRef = data.apiKey ? SecretManager.encrypt(data.apiKey) : null;
  }
  if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl || null;

  const capsInput = input as UpdateUserBotInput;
  if (capsInput.behaviors !== undefined) {
    // Behavior save = recompile the executed configuration from behaviors.
    // Empty array clears behaviors AND the compiled artifacts they owned.
    try {
      const behaviors = capsInput.behaviors as BotBehaviorSpec[];
      const compiled = behaviors.length ? compileBehaviors(behaviors) : { commands: [], replies: [] };
      const caps = serializeCapabilities({ commands: compiled.commands, replies: compiled.replies });
      patch.commandsJson = caps.commandsJson;
      patch.repliesJson = caps.repliesJson;
      patch.behaviorsJson = serializeBehaviors(behaviors);
    } catch (err) {
      if (err instanceof BehaviorCompileError) {
        return { error: err.issues.join(' '), fields: { behaviors: err.issues.join(' ') } };
      }
      if (err instanceof z.ZodError) {
        return { error: 'Validation failed', fields: formatZodError(err) };
      }
      throw err;
    }
  } else if (capsInput.commands || capsInput.replies) {
    // Advanced/manual path: direct edits to the executed configuration.
    // They stand until the next behavior save recompiles (stated in the UI).
    const caps = serializeCapabilities({ commands: capsInput.commands, replies: capsInput.replies });
    patch.commandsJson = caps.commandsJson;
    patch.repliesJson = caps.repliesJson;
  }

  if (Object.keys(patch).length === 0) return { bot: toUserBotDTO(existing) };
  const row = await db.bot.update({ where: { id: botId }, data: patch });
  return { bot: toUserBotDTO(row) };
}

export async function deleteUserBot(userId: string, botId: string): Promise<boolean> {
  const existing = await db.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
  if (!existing) return false;
  await db.bot.delete({ where: { id: botId } });
  return true;
}

// ---------------------------------------------------------------------------
// Lifecycle (start/stop/restart) — ownership-checked wrappers
// ---------------------------------------------------------------------------

export async function userBotLifecycle(
  userId: string,
  botId: string,
  action: 'start' | 'stop' | 'restart',
  publicBaseUrl: string | null,
): Promise<{ ok: true; status: string } | { ok: false; error: string; status?: number }> {
  const bot = await db.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true, telegramTokenRef: true } });
  if (!bot) return { ok: false, error: 'Bot not found', status: 404 };
  if (action !== 'stop' && !bot.telegramTokenRef) {
    return { ok: false, error: 'This bot has no Telegram token yet. Add the token from @BotFather first.' };
  }
  const { startBot, stopBot, restartBot } = await import('../runtime/transport');
  const result =
    action === 'start'
      ? await startBot(botId, { publicBaseUrl })
      : action === 'stop'
        ? await stopBot(botId)
        : await restartBot(botId, { publicBaseUrl });
  if (!result.ok) return { ok: false, error: result.detail ?? 'Lifecycle action failed.' };
  return { ok: true, status: result.status };
}

// ---------------------------------------------------------------------------
// Test console — one REAL pipeline turn against a capturing sender
// ---------------------------------------------------------------------------

export interface TestTurnResult {
  sends: CapturedSend[];
  error?: string;
}

async function runtimeRecordFor(botId: string): Promise<RuntimeBotRecord | null> {
  const store = createPrismaRuntimeStore(db);
  return store.getBot(botId);
}

/** Text message test — runs the shared pipeline exactly as Telegram would. */
export async function testBotTextTurn(userId: string, botId: string, text: string): Promise<TestTurnResult> {
  const bot = await db.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
  if (!bot) return { sends: [], error: 'Bot not found' };
  const record = await runtimeRecordFor(botId);
  if (!record) return { sends: [], error: 'Bot not found' };

  const sender = capturingSender();
  try {
    await handleBotMessage(record, sender, {
      chatId: 'test:console',
      text: text.slice(0, 4000),
      fromBot: false,
      fromName: 'console',
      fromFirstName: 'Tester',
      chatType: 'private',
    }, { store: createPrismaRuntimeStore(db) });
    return { sends: sender.sends };
  } catch (err) {
    return { sends: sender.sends, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Button-press test — runs the callback path of the pipeline. */
export async function testBotButtonTurn(userId: string, botId: string, callbackData: string): Promise<TestTurnResult> {
  const bot = await db.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
  if (!bot) return { sends: [], error: 'Bot not found' };
  const record = await runtimeRecordFor(botId);
  if (!record) return { sends: [], error: 'Bot not found' };

  const sender = capturingSender();
  try {
    await handleBotCallback(record, sender, {
      chatId: 'test:console',
      callbackId: 'test-callback',
      data: callbackData.slice(0, 64),
      fromName: 'console',
    }, { store: createPrismaRuntimeStore(db) });
    return { sends: sender.sends };
  } catch (err) {
    return { sends: sender.sends, error: err instanceof Error ? err.message : String(err) };
  }
}
