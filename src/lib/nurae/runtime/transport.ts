/**
 * NURAE — bot transport layer (spec Steps 2, 5, 8).
 *
 * Two transports, one pipeline:
 *
 *  - WEBHOOK (primary, Vercel-compatible):
 *      start = verify token (getMe) → register webhook (setWebhook + secret)
 *      stop  = remove webhook (deleteWebhook)
 *      Updates arrive as HTTPS POSTs at /api/telegram/webhook/{botId} and are
 *      processed statelessly through the shared pipeline. No persistent
 *      process, no in-memory state — the DB is the source of truth.
 *
 *  - POLLING (local development fallback):
 *      start = verify token → deleteWebhook → in-process long-poll loop
 *      (BotManager + BotRuntime). Requires a long-lived Node process; refuse
 *      to start this transport on serverless platforms.
 *
 * Webhook choice rationale (Step 5): webhook mode is stateless, survives
 * deploys, gets Telegram's automatic redelivery on failures, and is the only
 * mode compatible with serverless hosting. Polling is kept because localhost
 * has no public URL for Telegram to call.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TelegramAdapter, TelegramApiError, WebhookInfo } from '../telegram/adapter';
import { BotManager } from './bot-manager';
import { BotRuntime } from './bot-runtime';
import { createPrismaRuntimeStore, RuntimeStore } from './store';
import { handleBotMessage, updateToInboundMessage, TelegramUpdateLike } from './pipeline';
import { db } from '@/lib/db';
import { SecretManager } from '../secrets';

export type Transport = 'webhook' | 'polling';

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

export function resolveTransport(): Transport {
  const raw = (process.env.NURAE_BOT_TRANSPORT || 'webhook').trim().toLowerCase();
  return raw === 'polling' ? 'polling' : 'webhook';
}

export function isServerless(): boolean {
  return process.env.VERCEL === '1';
}

/** Public base URL for webhook registration. */
export function resolvePublicBaseUrl(req?: Request): string | null {
  const configured = process.env.NURAE_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (req) {
    const proto = req.headers.get('x-forwarded-proto');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (host) return `${proto ?? 'http'}://${host}`;
    // Fallback: derive from the request URL itself (works in tests and when
    // no proxy headers are present; Vercel supplies x-forwarded-host above).
    try {
      const url = new URL(req.url);
      if (url.hostname) return `${url.protocol.replace(/:$/, '')}://${url.host}`;
    } catch {
      /* ignore malformed URLs */
    }
  }
  return null;
}

function webhookUrlFor(baseUrl: string, botId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/telegram/webhook/${botId}`;
}

/** Telegram requires HTTPS (non-HTTPS only tolerable for local mock setups). */
function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Webhook base URL is not a valid URL.';
  }
  if (parsed.protocol === 'https:') return null;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
  const hasApiOverride = Boolean(process.env.NURAE_TELEGRAM_API_BASE);
  if (parsed.protocol === 'http:' && (isLocal || hasApiOverride)) return null;
  return 'Telegram webhooks require an HTTPS public URL. Set NURAE_PUBLIC_BASE_URL to your HTTPS origin.';
}

// ---------------------------------------------------------------------------
// In-process BotManager (polling transport only)
// ---------------------------------------------------------------------------

const globalForRuntime = globalThis as unknown as { nuraeManager: BotManager | undefined };

function getManager(): BotManager {
  if (!globalForRuntime.nuraeManager) {
    globalForRuntime.nuraeManager = new BotManager({ store: createStore() });
  }
  return globalForRuntime.nuraeManager;
}

function createStore(): RuntimeStore {
  return createPrismaRuntimeStore(db);
}

function adapterFor(token: string): TelegramAdapter {
  return new TelegramAdapter({ token });
}

// ---------------------------------------------------------------------------
// State transitions (Step 8) — enforced in the database, not just in memory
// ---------------------------------------------------------------------------

interface TransitionResult {
  applied: boolean;
  status: string;
}

/**
 * Atomically move the bot's persisted status forward. The UPDATE only matches
 * the expected source states, so racing callers cannot corrupt the state.
 */
async function transitionStatus(botId: string, from: readonly string[], to: string): Promise<TransitionResult> {
  const result = await db.bot.updateMany({
    where: { id: botId, status: { in: [...from] } },
    data: { status: to, ...(to === 'error' ? {} : { statusDetail: null }) },
  });
  return { applied: result.count > 0, status: to };
}

async function log(
  botId: string | null,
  level: 'info' | 'warn' | 'error',
  message: string,
  event?: string,
): Promise<void> {
  await db.log.create({ data: { botId, level, message, event: event ?? null } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Lifecycle: start / stop / restart / status
// ---------------------------------------------------------------------------

export interface LifecycleOutcome {
  ok: boolean;
  status: string;
  detail?: string;
}

export async function startBot(botId: string, opts?: { publicBaseUrl?: string | null }): Promise<LifecycleOutcome> {
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) return { ok: false, status: 'stopped', detail: 'Bot not found' };

  if (!bot.enabled) {
    const detail = 'Bot is disabled. Enable it in configuration before starting.';
    await log(botId, 'warn', detail, 'BOT_ERROR');
    return { ok: false, status: bot.status, detail };
  }

  const transport = resolveTransport();

  if (transport === 'polling' && isServerless()) {
    const detail =
      'Polling transport cannot run on serverless platforms (no persistent process). Use NURAE_BOT_TRANSPORT=webhook.';
    await log(botId, 'error', detail, 'BOT_ERROR');
    return { ok: false, status: bot.status, detail };
  }

  const transition = await transitionStatus(botId, ['stopped', 'error'], 'starting');
  if (!transition.applied && bot.status !== 'starting') {
    return { ok: false, status: bot.status, detail: `Bot is ${bot.status}; stop it before starting.` };
  }

  await log(botId, 'info', `Starting bot (transport: ${transport}): verifying Telegram identity…`, 'BOT_STARTING');

  try {
    let token = '';
    try {
      token = SecretManager.decrypt(bot.telegramTokenRef);
    } catch {
      throw new Error('Stored Telegram token could not be decrypted (secret key mismatch?). Re-enter the token.');
    }

    if (transport === 'webhook') {
      const adapter = adapterFor(token);
      const me = await adapter.getMe();
      const base = opts?.publicBaseUrl ?? resolvePublicBaseUrl();
      if (!base) throw new Error('No public base URL available for webhook registration. Set NURAE_PUBLIC_BASE_URL.');
      const url = webhookUrlFor(base, botId);
      const urlError = validateWebhookUrl(url);
      if (urlError) throw new Error(urlError);

      const secret = randomBytes(32).toString('base64url');
      await adapter.setWebhook(url, { secretToken: secret });
      await db.bot.update({
        where: { id: botId },
        data: {
          status: 'running',
          statusDetail: null,
          transport: 'webhook',
          webhookSecretRef: SecretManager.encrypt(secret),
          telegramUsername: me.username ? `@${me.username}` : null,
          lastStartedAt: new Date(),
        },
      });
      await log(
        botId,
        'info',
        `Bot is live via webhook as ${me.username ? '@' + me.username : me.id} (provider: ${bot.provider}, model: ${bot.model}).`,
        'BOT_STARTED',
      );
      await log(botId, 'info', 'Webhook registered with Telegram.', 'WEBHOOK_REGISTERED');
      return { ok: true, status: 'running' };
    }

    // Polling transport (local development).
    const record = await createStore().getBot(botId);
    if (!record) return { ok: false, status: 'starting', detail: 'Bot not found' };
    await getManager().startBot(botId);
    return { ok: true, status: 'running' };
  } catch (err) {
    const detail = err instanceof TelegramApiError || err instanceof Error ? err.message : String(err);
    await db.bot.updateMany({
      where: { id: botId, status: { in: ['starting'] } },
      data: { status: 'error', statusDetail: detail },
    });
    await log(botId, 'error', detail, 'BOT_ERROR');
    return { ok: false, status: 'error', detail };
  }
}

export async function stopBot(botId: string): Promise<LifecycleOutcome> {
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) return { ok: false, status: 'stopped', detail: 'Bot not found' };

  const transition = await transitionStatus(botId, ['running', 'starting', 'error'], 'stopping');
  if (!transition.applied && bot.status !== 'stopping') {
    if (bot.status === 'stopped') {
      // Idempotent stop: also drop any Telegram-side webhook for cleanliness.
      await dropWebhookQuietly(bot);
      return { ok: true, status: 'stopped' };
    }
    return { ok: false, status: bot.status, detail: `Bot is ${bot.status}; it cannot be stopped now.` };
  }

  await log(botId, 'info', 'Stopping bot…', 'BOT_STOPPING');
  try {
    if (bot.transport === 'polling' && getManager().isManaged(botId)) {
      await getManager().stopBot(botId);
    } else {
      await dropWebhookQuietly(bot);
    }
    await db.bot.updateMany({
      where: { id: botId, status: { in: ['stopping'] } },
      data: { status: 'stopped', statusDetail: null },
    });
    await log(botId, 'info', 'Bot stopped.', 'BOT_STOPPED');
    return { ok: true, status: 'stopped' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.bot.updateMany({
      where: { id: botId, status: { in: ['stopping'] } },
      data: { status: 'error', statusDetail: detail },
    });
    await log(botId, 'error', detail, 'BOT_ERROR');
    return { ok: false, status: 'error', detail };
  }
}

export async function restartBot(botId: string, opts?: { publicBaseUrl?: string | null }): Promise<LifecycleOutcome> {
  const stopped = await stopBot(botId);
  if (!stopped.ok && stopped.status !== 'stopped') {
    return stopped; // could not stop → do not start a duplicate
  }
  return startBot(botId, opts);
}

async function dropWebhookQuietly(bot: { id: string; telegramTokenRef: string }): Promise<void> {
  try {
    const adapter = adapterFor(SecretManager.decrypt(bot.telegramTokenRef));
    await adapter.deleteWebhook();
  } catch (err) {
    await log(
      bot.id,
      'warn',
      `Could not remove Telegram webhook: ${err instanceof Error ? err.message : String(err)}`,
      'TELEGRAM_SEND_FAILED',
    );
  }
}

// ---------------------------------------------------------------------------
// Status merge (persisted state + Telegram-side truth)
// ---------------------------------------------------------------------------

export interface BotRuntimeStatus {
  status: string;
  managed: boolean;
  transport: string | null;
  pendingUpdateCount?: number;
  telegramLastErrorMessage?: string | null;
}

export async function getBotRuntimeStatus(botId: string): Promise<BotRuntimeStatus> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { id: true, status: true, transport: true, telegramTokenRef: true, webhookSecretRef: true },
  });
  if (!bot) return { status: 'stopped', managed: false, transport: null };

  if (bot.transport === 'polling') {
    const managed = getManager().isManaged(botId);
    const live = getManager().statusOf(botId).status;
    return {
      status: managed ? live : bot.status,
      managed,
      transport: 'polling',
    };
  }

  if (bot.status === 'running' && bot.webhookSecretRef) {
    try {
      const adapter = adapterFor(SecretManager.decrypt(bot.telegramTokenRef));
      const info = await adapter.getWebhookInfo();
      if (!info.url) {
        // Someone deleted the webhook out-of-band → surface the drift.
        await transitionStatus(botId, ['running'], 'error');
        await db.bot.updateMany({
          where: { id: botId, status: 'error' },
          data: { statusDetail: 'Telegram reports no active webhook for this bot. Start it again.' },
        });
        await log(botId, 'error', 'Telegram reports no active webhook. Bot stopped or webhook removed externally.', 'BOT_ERROR');
        return { status: 'error', managed: false, transport: 'webhook' };
      }
      return {
        status: 'running',
        managed: true,
        transport: 'webhook',
        pendingUpdateCount: info.pending_update_count,
        telegramLastErrorMessage: info.last_error_message ?? null,
      };
    } catch {
      // Cannot reach Telegram right now — trust the persisted state.
      return { status: bot.status, managed: true, transport: 'webhook' };
    }
  }

  return { status: bot.status, managed: false, transport: bot.transport };
}

// ---------------------------------------------------------------------------
// Webhook ingestion (called by /api/telegram/webhook/[botId])
// ---------------------------------------------------------------------------

const RECENT_UPDATES_CAPACITY = 500;
const globalForDedup = globalThis as unknown as { nuraeRecentUpdates: Map<string, Set<number>> | undefined };

function seenUpdate(botId: string, updateId: number): boolean {
  if (!globalForDedup.nuraeRecentUpdates) globalForDedup.nuraeRecentUpdates = new Map();
  const map = globalForDedup.nuraeRecentUpdates;
  let set = map.get(botId);
  if (!set) {
    set = new Set();
    map.set(botId, set);
  }
  if (set.has(updateId)) return true;
  set.add(updateId);
  if (set.size > RECENT_UPDATES_CAPACITY) {
    // Drop the oldest entries (Set preserves insertion order).
    for (const value of set) {
      set.delete(value);
      if (set.size <= RECENT_UPDATES_CAPACITY / 2) break;
    }
  }
  return false;
}

/** Verify the X-Telegram-Bot-Api-Secret-Token header (constant-time). */
export async function verifyWebhookSecret(botId: string, presented: string | null): Promise<boolean> {
  if (!presented) return false;
  const bot = await db.bot.findUnique({ where: { id: botId }, select: { webhookSecretRef: true } });
  if (!bot?.webhookSecretRef) return false;
  let expected: string;
  try {
    expected = SecretManager.decrypt(bot.webhookSecretRef);
  } catch {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Process a webhook update end-to-end. Returns false when the update was a duplicate. */
export async function ingestWebhookUpdate(botId: string, update: TelegramUpdateLike): Promise<boolean> {
  if (seenUpdate(botId, update.update_id)) return false;
  const msg = updateToInboundMessage(update);
  if (!msg) return true; // nothing this release handles (non-text updates are ignored)

  const store = createStore();
  const record = await store.getBot(botId);
  if (!record) throw new Error('Bot not found');

  await store.createLog(
    botId,
    'info',
    `Message received from chat ${msg.chatId} (${msg.text.length} chars).`,
    'TELEGRAM_MESSAGE_RECEIVED',
  );
  await handleBotMessage(record, adapterFor(record.telegramToken), msg, { store });
  return true;
}

export type { WebhookInfo };
