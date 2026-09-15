/**
 * NURAE — runtime storage boundary.
 *
 * The bot runtime talks to persistence only through this interface, so the
 * runtime logic is storage-agnostic and testable. The default implementation
 * is Prisma-backed (SQLite this release; PostgreSQL-ready later).
 *
 * Secret boundary: the Prisma-backed store DECRYPTS the Telegram token / API
 * key when materializing a runtime record. Secrets never leave the trusted
 * runtime boundary: never logged, never returned over HTTP.
 */

import { PrismaClient } from '@prisma/client';
import { SecretManager } from '../secrets';
import type { ChatMessage } from '../ai/types';
import { loadCapabilities, type BotCapabilities } from '../bots/capabilities';

export interface RuntimeBotRecord {
  id: string;
  projectId: string;
  /** Customer id this bot belongs to; null = platform-owned (never billed). */
  ownerId: string | null;
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  status: string;
  /** Validated capabilities loaded from the JSON columns (degrade to empty). */
  capabilities: BotCapabilities;
  /** Decrypted Telegram token — runtime-internal use only. */
  telegramToken: string;
  /** Decrypted AI provider API key or null. */
  apiKey: string | null;
  baseUrl: string | null;
  /** @username from the last start (group mention gating). */
  telegramUsername?: string | null;
}

export interface RuntimeStatusPatch {
  status?: string;
  statusDetail?: string | null;
  telegramUsername?: string | null;
  lastStartedAt?: Date | null;
  transport?: string | null;
  /** Encrypted webhook secret reference — written by the transport layer only. */
  webhookSecretRef?: string | null;
}

// ---------------------------------------------------------------------------
// Per-user persistent state (attributes, carts, progress, pending answers)
// ---------------------------------------------------------------------------

export interface BotUserStateData {
  botId: string;
  chatId: string;
  attributes: Record<string, string>;
  /** Attribute currently being collected, or "_schedule" while parsing a reminder. */
  awaiting: string | null;
  /** Where a multi-turn flow continues after the pending answer. */
  resumeRuleId: string | null;
  resumeStep: number | null;
  /** Last /start deep-link payload (attribution, bind flows). */
  startPayload: string | null;
}

export interface BotUserStatePatch {
  /** Merge (or clear with null values) individual attributes. */
  attributes?: Record<string, string | null>;
  awaiting?: string | null;
  resume?: { ruleId: string; step: number } | null;
  startPayload?: string | null;
  touch?: boolean;
}

export interface BotScheduleRow {
  id: string;
  botId: string;
  chatId: string;
  text: string;
  runAt: Date;
  recurrence: string;
  status: string;
  lastError: string | null;
}

export interface BotBroadcastRow {
  id: string;
  botId: string;
  text: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  lastError: string | null;
  createdAt: Date;
}

export interface BotPaymentRow {
  id: string;
  botId: string;
  chatId: string;
  chargeId: string;
  amount: number;
  currency: string;
  payload: string;
  title: string;
  createdAt: Date;
}

export interface RuntimeStore {
  getBot(botId: string): Promise<RuntimeBotRecord | null>;
  updateBotRuntimeState(botId: string, patch: RuntimeStatusPatch): Promise<void>;
  /** Recent messages for a chat, oldest → newest, capped to `limit`. */
  getRecentMessages(botId: string, chatId: string, limit: number): Promise<ChatMessage[]>;
  appendUserMessage(botId: string, chatId: string, content: string): Promise<void>;
  appendAssistantMessage(botId: string, chatId: string, content: string): Promise<void>;
  /** Keep only the newest `keep` messages for this conversation. */
  trimConversation(botId: string, chatId: string, keep: number): Promise<void>;
  createLog(
    botId: string | null,
    level: 'info' | 'warn' | 'error',
    message: string,
    event?: string,
  ): Promise<void>;
  // --- per-user state -----------------------------------------------------
  getUserState(botId: string, chatId: string): Promise<BotUserStateData | null>;
  updateUserState(botId: string, chatId: string, patch: BotUserStatePatch): Promise<void>;
  /** Every chat this bot has ever seen (broadcast audience). */
  listChatIds(botId: string): Promise<string[]>;
  /**
   * Users (private chats) holding a given attribute, with its raw value and
   * stored display name — powers draws and leaderboards. Oldest-seen first
   * so ties resolve deterministically.
   */
  listUsersWithAttribute(
    botId: string,
    attribute: string,
  ): Promise<Array<{ chatId: string; value: string; name: string | null }>>;
  // --- Stars payments ------------------------------------------------------
  recordPayment(p: Omit<BotPaymentRow, 'id' | 'createdAt'>): Promise<void>;
  listPayments(botId: string): Promise<BotPaymentRow[]>;
  // --- scheduler -----------------------------------------------------------
  createSchedule(row: { botId: string; chatId: string; text: string; runAt: Date; recurrence?: string; createdBy?: string | null }): Promise<BotScheduleRow>;
  listSchedules(botId: string): Promise<BotScheduleRow[]>;
  cancelSchedule(botId: string, scheduleId: string): Promise<boolean>;
  /** Rewrite a pending schedule's text (fleet sentinel migration). */
  updateScheduleText(scheduleId: string, text: string): Promise<void>;
  /** Due pending schedules (oldest first) — claimed by the task ticker. */
  dueSchedules(now: Date, botId?: string, limit?: number): Promise<BotScheduleRow[]>;
  markScheduleSent(id: string, nextRunAt: Date | null): Promise<void>;
  markScheduleFailed(id: string, error: string): Promise<void>;
  // --- broadcasts ----------------------------------------------------------
  createBroadcast(botId: string, text: string, total: number): Promise<BotBroadcastRow>;
  /** Atomically claim one pending broadcast (multi-instance safe). */
  claimPendingBroadcast(botId?: string): Promise<BotBroadcastRow | null>;
  /** Merge delivery progress; status='done' finishes the broadcast. */
  updateBroadcastProgress(id: string, sent: number, failed: number, opts?: { running?: boolean; done?: boolean; failed?: boolean; lastError?: string }): Promise<void>;
  listBroadcasts(botId: string): Promise<BotBroadcastRow[]>;
}

const STATE_ATTRIBUTES_MAX = 64;

function parseAttributes(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k.slice(0, 64)] = v.slice(0, 2000);
    }
    return out;
  } catch {
    return {};
  }
}

export function createPrismaRuntimeStore(prisma: PrismaClient): RuntimeStore {
  return {
    async getBot(botId) {
      const row = await prisma.bot.findUnique({ where: { id: botId } });
      if (!row) return null;
      // Bots can exist before a Telegram token is added (the official NURAE bot
      // is seeded without one). Null ref ⇒ empty token, no failure.
      let telegramToken = '';
      if (row.telegramTokenRef) {
        try {
          telegramToken = SecretManager.decrypt(row.telegramTokenRef);
        } catch {
          throw new Error(
            'Stored Telegram token could not be decrypted (secret key mismatch?). Re-enter the token.',
          );
        }
      }
      let apiKey: string | null = null;
      if (row.apiKeyRef) {
        try {
          apiKey = SecretManager.decrypt(row.apiKeyRef);
        } catch {
          apiKey = null;
        }
      }
      return {
        id: row.id,
        projectId: row.projectId,
        ownerId: row.ownerId,
        name: row.name,
        systemPrompt: row.systemPrompt,
        provider: row.provider,
        model: row.model,
        temperature: row.temperature,
        maxTokens: row.maxTokens,
        memorySize: row.memorySize,
        enabled: row.enabled,
        status: row.status,
        capabilities: loadCapabilities(row),
        telegramToken,
        apiKey,
        baseUrl: row.baseUrl,
        telegramUsername: row.telegramUsername,
      };
    },

    async updateBotRuntimeState(botId, patch) {
      const data: Record<string, unknown> = {};
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.statusDetail !== undefined) data.statusDetail = patch.statusDetail;
      if (patch.telegramUsername !== undefined) data.telegramUsername = patch.telegramUsername;
      if (patch.lastStartedAt !== undefined) data.lastStartedAt = patch.lastStartedAt;
      if (patch.transport !== undefined) data.transport = patch.transport;
      if (patch.webhookSecretRef !== undefined) data.webhookSecretRef = patch.webhookSecretRef;
      if (Object.keys(data).length === 0) return;
      await prisma.bot.update({ where: { id: botId }, data }).catch(() => {
        // Bot row may have been deleted while running — ignore.
      });
    },

    async getRecentMessages(botId, chatId, limit) {
      const conversation = await prisma.conversation.findUnique({
        where: { botId_chatId: { botId, chatId } },
      });
      if (!conversation) return [];
      const rows = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
      return rows
        .reverse()
        .map((m) => ({ role: m.role as ChatMessage['role'], content: m.content }));
    },

    async appendUserMessage(botId, chatId, content) {
      await appendMessage(prisma, botId, chatId, 'user', content);
    },

    async appendAssistantMessage(botId, chatId, content) {
      await appendMessage(prisma, botId, chatId, 'assistant', content);
    },

    async trimConversation(botId, chatId, keep) {
      const conversation = await prisma.conversation.findUnique({
        where: { botId_chatId: { botId, chatId } },
      });
      if (!conversation) return;
      const ids = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { timestamp: 'desc' },
        select: { id: true },
        skip: keep,
      });
      if (ids.length === 0) return;
      await prisma.message.deleteMany({ where: { id: { in: ids.map((m) => m.id) } } });
    },

    async createLog(botId, level, message, event) {
      await prisma.log.create({ data: { botId, level, message, event: event ?? null } }).catch(() => undefined);
    },

    // --- per-user state ----------------------------------------------------

    async getUserState(botId, chatId) {
      const row = await prisma.botUserState.findUnique({
        where: { botId_chatId: { botId, chatId } },
      });
      if (!row) return null;
      return {
        botId: row.botId,
        chatId: row.chatId,
        attributes: parseAttributes(row.attributes),
        awaiting: row.awaiting,
        resumeRuleId: row.resumeRuleId,
        resumeStep: row.resumeStep,
        startPayload: row.startPayload,
      };
    },

    async updateUserState(botId, chatId, patch) {
      const data: Record<string, unknown> = {};
      if (patch.attributes) {
        // Merge into the stored map (null value = remove the key).
        const existing = await prisma.botUserState.findUnique({
          where: { botId_chatId: { botId, chatId } },
          select: { attributes: true },
        });
        const merged = parseAttributes(existing?.attributes ?? '{}');
        for (const [k, v] of Object.entries(patch.attributes)) {
          if (v === null) delete merged[k];
          else merged[k.slice(0, 64)] = v.slice(0, 2000);
        }
        // Hard cap: oldest entries (insertion order) drop first.
        const keys = Object.keys(merged);
        if (keys.length > STATE_ATTRIBUTES_MAX) {
          for (const k of keys.slice(0, keys.length - STATE_ATTRIBUTES_MAX)) delete merged[k];
        }
        data.attributes = JSON.stringify(merged);
      }
      if (patch.awaiting !== undefined) data.awaiting = patch.awaiting;
      if (patch.resume !== undefined) {
        data.resumeRuleId = patch.resume?.ruleId ?? null;
        data.resumeStep = patch.resume?.step ?? null;
      }
      if (patch.startPayload !== undefined) data.startPayload = patch.startPayload;
      if (patch.touch) data.lastSeenAt = new Date();
      if (Object.keys(data).length === 0) return;
      await prisma.botUserState
        .upsert({
          where: { botId_chatId: { botId, chatId } },
          update: data,
          create: {
            botId,
            chatId,
            ...(data.attributes !== undefined ? { attributes: data.attributes as string } : {}),
            ...(data.awaiting !== undefined ? { awaiting: data.awaiting as string | null } : {}),
            ...(data.resumeRuleId !== undefined ? { resumeRuleId: data.resumeRuleId as string | null } : {}),
            ...(data.resumeStep !== undefined ? { resumeStep: data.resumeStep as number | null } : {}),
            ...(data.startPayload !== undefined ? { startPayload: data.startPayload as string | null } : {}),
            ...(data.lastSeenAt ? { lastSeenAt: data.lastSeenAt as Date } : {}),
          },
        })
        .catch(() => undefined); // bot deleted mid-flight — state is disposable
    },

    async listChatIds(botId) {
      const states = await prisma.botUserState.findMany({
        where: { botId },
        select: { chatId: true },
        orderBy: { lastSeenAt: 'desc' },
      });
      const conversations = await prisma.conversation.findMany({
        where: { botId },
        select: { chatId: true },
      });
      return [...new Set([...states.map((s) => s.chatId), ...conversations.map((c) => c.chatId)])];
    },

    async listUsersWithAttribute(botId, attribute) {
      const states = await prisma.botUserState.findMany({
        where: { botId },
        select: { chatId: true, attributes: true },
        orderBy: { lastSeenAt: 'asc' },
        take: 2000,
      });
      const out: Array<{ chatId: string; value: string; name: string | null }> = [];
      for (const s of states) {
        const attrs = parseAttributes(s.attributes);
        const value = attrs[attribute];
        if (value === undefined) continue;
        // Private chats are numeric ids; group ids (-100…) hold per-GROUP
        // state, not per-user entries, and never belong in a draw.
        if (!/^-?\d+$/.test(s.chatId) || s.chatId.startsWith('-')) continue;
        out.push({ chatId: s.chatId, value, name: attrs['name'] ?? null });
      }
      return out;
    },

    // --- payments -----------------------------------------------------------

    async recordPayment(p) {
      await prisma.botPayment
        .create({
          data: {
            botId: p.botId,
            chatId: p.chatId,
            chargeId: p.chargeId,
            amount: p.amount,
            currency: p.currency,
            payload: p.payload,
            title: p.title,
          },
        })
        .catch(() => undefined); // duplicate chargeId (webhook redelivery) — already recorded
    },

    async listPayments(botId) {
      const rows = await prisma.botPayment.findMany({
        where: { botId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        botId: r.botId,
        chatId: r.chatId,
        chargeId: r.chargeId,
        amount: r.amount,
        currency: r.currency,
        payload: r.payload,
        title: r.title,
        createdAt: r.createdAt,
      }));
    },

    // --- scheduler ----------------------------------------------------------

    async createSchedule(row) {
      const created = await prisma.botSchedule.create({
        data: {
          botId: row.botId,
          chatId: row.chatId,
          text: row.text.slice(0, 4000),
          runAt: row.runAt,
          recurrence: row.recurrence ?? 'once',
          createdBy: row.createdBy ?? null,
        },
      });
      return {
        id: created.id,
        botId: created.botId,
        chatId: created.chatId,
        text: created.text,
        runAt: created.runAt,
        recurrence: created.recurrence,
        status: created.status,
        lastError: created.lastError,
      };
    },

    async listSchedules(botId) {
      const rows = await prisma.botSchedule.findMany({
        where: { botId, status: { in: ['pending', 'failed'] } },
        orderBy: { runAt: 'asc' },
        take: 200,
      });
      return rows.map((r) => ({
        id: r.id,
        botId: r.botId,
        chatId: r.chatId,
        text: r.text,
        runAt: r.runAt,
        recurrence: r.recurrence,
        status: r.status,
        lastError: r.lastError,
      }));
    },

    async cancelSchedule(botId, scheduleId) {
      const result = await prisma.botSchedule.updateMany({
        where: { id: scheduleId, botId, status: 'pending' },
        data: { status: 'cancelled' },
      });
      return result.count > 0;
    },

    async dueSchedules(now, botId, limit = 50) {
      const rows = await prisma.botSchedule.findMany({
        where: {
          status: 'pending',
          runAt: { lte: now },
          ...(botId ? { botId } : {}),
        },
        orderBy: { runAt: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        botId: r.botId,
        chatId: r.chatId,
        text: r.text,
        runAt: r.runAt,
        recurrence: r.recurrence,
        status: r.status,
        lastError: r.lastError,
      }));
    },

    async markScheduleSent(id, nextRunAt) {
      if (nextRunAt) {
        await prisma.botSchedule.update({
          where: { id },
          data: { runAt: nextRunAt, status: 'pending', lastError: null },
        }).catch(() => undefined);
      } else {
        await prisma.botSchedule.update({
          where: { id },
          data: { status: 'sent', lastError: null },
        }).catch(() => undefined);
      }
    },

    async markScheduleFailed(id, error) {
      await prisma.botSchedule.update({
        where: { id },
        data: { status: 'failed', lastError: error.slice(0, 500) },
      }).catch(() => undefined);
    },

    async updateScheduleText(scheduleId, text) {
      await prisma.botSchedule
        .updateMany({
          where: { id: scheduleId, status: 'pending' },
          data: { text: text.slice(0, 4000) },
        })
        .catch(() => undefined);
    },

    // --- broadcasts ---------------------------------------------------------

    async createBroadcast(botId, text, total) {
      const created = await prisma.botBroadcast.create({
        data: { botId, text: text.slice(0, 4000), total },
      });
      return {
        id: created.id,
        botId: created.botId,
        text: created.text,
        status: created.status,
        total: created.total,
        sent: created.sent,
        failed: created.failed,
        lastError: created.lastError,
        createdAt: created.createdAt,
      };
    },

    async claimPendingBroadcast(botId) {
      // Find the oldest pending broadcast, then claim it atomically with a
      // conditional update (two workers can never both claim the same row).
      const candidate = await prisma.botBroadcast.findFirst({
        where: { status: 'pending', ...(botId ? { botId } : {}) },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const claimed = await prisma.botBroadcast.updateMany({
        where: { id: candidate.id, status: 'pending' },
        data: { status: 'running' },
      });
      if (claimed.count === 0) return null;
      return {
        id: candidate.id,
        botId: candidate.botId,
        text: candidate.text,
        status: 'running',
        total: candidate.total,
        sent: candidate.sent,
        failed: candidate.failed,
        lastError: candidate.lastError,
        createdAt: candidate.createdAt,
      };
    },

    async updateBroadcastProgress(id, sent, failed, opts) {
      const data: Record<string, unknown> = { sent, failed };
      if (opts?.done) data.status = 'done';
      if (opts?.failed) data.status = 'failed';
      if (opts?.lastError !== undefined) data.lastError = opts.lastError.slice(0, 500);
      await prisma.botBroadcast.update({ where: { id }, data }).catch(() => undefined);
    },

    async listBroadcasts(botId) {
      const rows = await prisma.botBroadcast.findMany({
        where: { botId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map((r) => ({
        id: r.id,
        botId: r.botId,
        text: r.text,
        status: r.status,
        total: r.total,
        sent: r.sent,
        failed: r.failed,
        lastError: r.lastError,
        createdAt: r.createdAt,
      }));
    },
  };
}

async function appendMessage(
  prisma: PrismaClient,
  botId: string,
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const conversation = await prisma.conversation.upsert({
    where: { botId_chatId: { botId, chatId } },
    update: {},
    create: { botId, chatId },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, role, content },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
}
