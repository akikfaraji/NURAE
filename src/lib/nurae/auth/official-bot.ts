/**
 * NURAE — the official NURAE CS bot.
 *
 * One bot row is auto-seeded ("NURAE CS Bot" inside the "NURAE Official"
 * project). It is a regular Bot: the admin fills in the keys (Telegram token
 * + AI provider key) in the dashboard and starts it — it then serves
 * customers on Telegram. The SAME row powers the public web chat
 * (POST /api/support/chat): only the AI key is needed there.
 *
 * Seeding is idempotent and self-healing: the pointer lives in site_settings
 * (official_bot_id) and is re-created if the row disappears. Seeding never
 * overwrites admin edits.
 */

import { db } from '@/lib/db';
import { selectProvider } from '../ai/registry';
import { AIError, type ChatMessage } from '../ai/types';
import { createPrismaRuntimeStore } from '../runtime/store';
import { getSiteInfo, officialBotPrompt } from './settings';
import { rateLimit } from './rate-limit';
import { chargeFeature } from '../billing/wallet';

export const OFFICIAL_PROJECT_NAME = 'NURAE Official';
export const OFFICIAL_BOT_NAME = 'NURAE CS Bot';
const OFFICIAL_BOT_POINTER = 'official_bot_id';

/** Ensure exactly one official bot exists; return its id. Never throws far. */
export async function ensureOfficialBot(): Promise<string | null> {
  try {
    // Fast path: pointer resolves to a live bot.
    const pointer = await db.siteSetting.findUnique({ where: { key: OFFICIAL_BOT_POINTER } });
    if (pointer) {
      const existing = await db.bot.findUnique({ where: { id: pointer.value } });
      if (existing) return existing.id;
    }
    // Slow path: find by name (pointer lost / first boot), else create.
    let project = await db.project.findFirst({ where: { name: OFFICIAL_PROJECT_NAME } });
    if (!project) {
      project = await db.project.create({
        data: {
          name: OFFICIAL_PROJECT_NAME,
          description: 'The official NURAE customer-support bot. Provided with the platform — fill in the keys and run.',
        },
      });
    }
    let bot = await db.bot.findFirst({ where: { projectId: project.id, name: OFFICIAL_BOT_NAME } });
    if (!bot) {
      const info = await getSiteInfo();
      bot = await db.bot.create({
        data: {
          projectId: project.id,
          name: OFFICIAL_BOT_NAME,
          description:
            'Official NURAE support bot. Serves customers on the public site web chat and on Telegram once you add a bot token. Fill in the keys and start.',
          systemPrompt: officialBotPrompt(info),
          provider: 'openrouter',
          model: 'openrouter/free',
          temperature: 0.5,
        },
      });
    }
    await db.siteSetting.upsert({
      where: { key: OFFICIAL_BOT_POINTER },
      update: { value: bot.id },
      create: { key: OFFICIAL_BOT_POINTER, value: bot.id },
    });
    return bot.id;
  } catch (err) {
    console.error(
      `[NURAE] official bot seeding failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * One-time repair for bots created before the zai provider was removed
 * (V00.01.008). Their rows still carry provider='zai' / glm models, which the
 * config form cannot render (the provider is gone from the catalog) — the
 * admin literally cannot edit those bots' API keys. Map them to openrouter.
 * Idempotent: after the rewrite no row matches, so re-runs are no-ops.
 */
export async function migrateLegacyZaiBots(): Promise<number> {
  try {
    const stale = await db.bot.findMany({ where: { provider: 'zai' } });
    for (const bot of stale) {
      const model = /glm/i.test(bot.model) || bot.model === 'zai/free' ? 'openrouter/free' : bot.model;
      await db.bot.update({ where: { id: bot.id }, data: { provider: 'openrouter', model } });
      await db.log.create({
        data: {
          botId: bot.id,
          level: 'info',
          event: 'BOT_MIGRATED',
          message: `Provider "zai" was retired — this bot now uses "openrouter" (model: ${model}). The AI key from OPENROUTER_API_KEY applies until you store a bot-specific key.`,
        },
      });
    }
    return stale.length;
  } catch (err) {
    console.error(`[NURAE] zai->openrouter migration failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Get the official bot row (seeding first) or null when seeding is impossible. */
export async function getOfficialBot() {
  const id = await ensureOfficialBot();
  if (!id) return null;
  return db.bot.findUnique({ where: { id } });
}

export interface OfficialBotStatus {
  botId: string | null;
  ready: boolean; // AI answerable (own key OR env fallback)
  hasTelegramToken: boolean;
  hasApiKey: boolean;
  status: string | null; // Telegram runtime status
  telegramUsername: string | null;
  transport: string | null;
}

/** Admin-facing summary (no secrets). */
export async function officialBotStatus(): Promise<OfficialBotStatus> {
  const bot = await getOfficialBot();
  if (!bot) {
    return { botId: null, ready: false, hasTelegramToken: false, hasApiKey: false, status: null, telegramUsername: null, transport: null };
  }
  const selection = selectProvider(bot.provider, { apiKey: null, baseUrl: bot.baseUrl });
  const envKey = selection.info.apiKeyEnvVar ? process.env[selection.info.apiKeyEnvVar] || '' : '';
  const ready = selection.info.requiresKey ? Boolean(bot.apiKeyRef) || Boolean(envKey) : true;
  return {
    botId: bot.id,
    ready,
    hasTelegramToken: Boolean(bot.telegramTokenRef),
    hasApiKey: Boolean(bot.apiKeyRef),
    status: bot.status,
    telegramUsername: bot.telegramUsername,
    transport: bot.transport,
  };
}

// ---------------------------------------------------------------------------
// Web chat engine — reuses the pipeline's AI resolution, minus Telegram.
// ---------------------------------------------------------------------------

const CHAT_LIMIT = 20; // messages per minute per user
const CHAT_WINDOW_MS = 60 * 1000;
const MAX_MESSAGE_LEN = 2000;
const REPLY_CAP = 4000; // keep replies chat-friendly

export interface ChatOutcome {
  ok: boolean;
  reply: string | null;
  error?: string; // machine code
  message?: string; // human text
  status?: number;
}

/**
 * One web-chat turn for the official bot. chatId is `web:<userId>` so the
 * pipeline's conversation memory works per user, exactly like Telegram chats.
 * Never throws — failures come back as structured outcomes.
 */
export async function supportChatTurn(userId: string, text: string): Promise<ChatOutcome> {
  const trimmed = text.trim().slice(0, MAX_MESSAGE_LEN);
  if (!trimmed) return { ok: false, reply: null, error: 'empty_message', message: 'Type a message first.', status: 400 };

  const rl = rateLimit(`support-chat:${userId}`, CHAT_LIMIT, CHAT_WINDOW_MS);
  if (!rl.allowed) {
    return {
      ok: false,
      reply: null,
      error: 'rate_limited',
      message: `You are sending messages too quickly. Try again in ${rl.retryAfter}s.`,
      status: 429,
    };
  }

  const bot = await getOfficialBot();
  if (!bot) {
    return { ok: false, reply: null, error: 'official_bot_unavailable', message: 'The support bot is temporarily unavailable. Try again shortly.', status: 503 };
  }

  const store = createPrismaRuntimeStore(db);
  const chatId = `web:${userId}`;
  const selection = selectProvider(bot.provider, { apiKey: null, baseUrl: bot.baseUrl });
  let apiKey: string | null = null;
  if (bot.apiKeyRef) {
    try {
      const { SecretManager } = await import('../secrets');
      apiKey = SecretManager.decrypt(bot.apiKeyRef);
    } catch {
      apiKey = null;
    }
  }
  if (selection.info.requiresKey && !apiKey && !selection.apiKey) {
    return {
      ok: false,
      reply: null,
      error: 'bot_not_configured',
      message: 'The support bot is not configured yet — the site owner still has to add an AI key in the dashboard.',
      status: 503,
    };
  }

  await store.appendUserMessage(bot.id, chatId, trimmed);
  const history = await store.getRecentMessages(bot.id, chatId, bot.memorySize);
  const messages: ChatMessage[] = [{ role: 'system', content: bot.systemPrompt }, ...history];

  try {
    // Pay-as-you-use: the web support chat is an `ai_assistant` turn too.
    const charge = await chargeFeature(userId, 'ai_assistant').catch(() => null);
    if (charge?.outcome === 'skipped') {
      return {
        ok: false,
        reply: null,
        error: 'insufficient_credits',
        message: 'Out of credits — top up in Billing (Telegram Stars or crypto) to keep chatting.',
        status: 402,
      };
    }
    const resolvedKey = apiKey ?? selection.apiKey ?? null;
    let reply = await selection.provider.generate(messages, {
      model: bot.model,
      temperature: bot.temperature,
      maxTokens: bot.maxTokens,
      apiKey: resolvedKey,
      baseUrl: selection.baseUrl,
    });
    if (reply.length > REPLY_CAP) reply = `${reply.slice(0, REPLY_CAP)}…`;
    await store.appendAssistantMessage(bot.id, chatId, reply);
    if (bot.memorySize > 0) await store.trimConversation(bot.id, chatId, bot.memorySize);
    return { ok: true, reply };
  } catch (err) {
    const code = err instanceof AIError ? err.code : 'api_error';
    const detail = err instanceof Error ? err.message : String(err);
    await store.createLog(bot.id, 'error', `Web chat AI request failed — ${code}: ${detail}`, 'AI_REQUEST_FAILED');
    const human: Record<string, string> = {
      missing_credentials: 'The support bot has no AI key configured yet. (Site owner: add it in the dashboard.)',
      invalid_credentials: 'The AI provider rejected the configured key. (Site owner: check the dashboard logs.)',
      rate_limited: 'The AI provider is rate-limiting right now — try again in a moment.',
      timeout: 'The AI request timed out — try again.',
      network_error: 'Could not reach the AI provider — try again shortly.',
    };
    return {
      ok: false,
      reply: null,
      error: code,
      message: human[code] ?? 'The assistant could not answer right now — try again shortly.',
      status: err instanceof AIError && (code === 'missing_credentials' || code === 'invalid_credentials') ? 503 : 502,
    };
  }
}

/** Persisted chat history for one web user (oldest → newest, capped). */
export async function supportChatHistory(userId: string, limit = 50) {
  const bot = await getOfficialBot();
  if (!bot) return [];
  const conversation = await db.conversation.findUnique({
    where: { botId_chatId: { botId: bot.id, chatId: `web:${userId}` } },
  });
  if (!conversation) return [];
  const rows = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return rows
    .reverse()
    .map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp.toISOString() }));
}
