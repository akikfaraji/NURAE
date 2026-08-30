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

export interface RuntimeBotRecord {
  id: string;
  projectId: string;
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  status: string;
  /** Decrypted Telegram token — runtime-internal use only. */
  telegramToken: string;
  /** Decrypted AI provider API key or null. */
  apiKey: string | null;
  baseUrl: string | null;
}

export interface RuntimeStatusPatch {
  status?: string;
  statusDetail?: string | null;
  telegramUsername?: string | null;
  lastStartedAt?: Date | null;
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
  createLog(botId: string | null, level: 'info' | 'warn' | 'error', message: string): Promise<void>;
}

export function createPrismaRuntimeStore(prisma: PrismaClient): RuntimeStore {
  return {
    async getBot(botId) {
      const row = await prisma.bot.findUnique({ where: { id: botId } });
      if (!row) return null;
      let telegramToken = '';
      try {
        telegramToken = SecretManager.decrypt(row.telegramTokenRef);
      } catch {
        throw new Error(
          'Stored Telegram token could not be decrypted (secret key mismatch?). Re-enter the token.',
        );
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
        name: row.name,
        systemPrompt: row.systemPrompt,
        provider: row.provider,
        model: row.model,
        temperature: row.temperature,
        maxTokens: row.maxTokens,
        memorySize: row.memorySize,
        enabled: row.enabled,
        status: row.status,
        telegramToken,
        apiKey,
        baseUrl: row.baseUrl,
      };
    },

    async updateBotRuntimeState(botId, patch) {
      const data: Record<string, unknown> = {};
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.statusDetail !== undefined) data.statusDetail = patch.statusDetail;
      if (patch.telegramUsername !== undefined) data.telegramUsername = patch.telegramUsername;
      if (patch.lastStartedAt !== undefined) data.lastStartedAt = patch.lastStartedAt;
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

    async createLog(botId, level, message) {
      await prisma.log.create({ data: { botId, level, message } }).catch(() => undefined);
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
