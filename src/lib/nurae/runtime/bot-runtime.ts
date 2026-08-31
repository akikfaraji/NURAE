/**
 * NURAE — BotRuntime (polling transport; spec Steps 2, 4, 8).
 *
 * Owns exactly ONE bot for the LOCAL polling transport: Telegram long-poll
 * loop → shared pipeline (commands → memory → AI provider → reply).
 *
 * Webhook transport does NOT use this class — it processes updates directly
 * through the same pipeline (see transport.ts and the webhook API route),
 * because serverless platforms cannot host persistent poll loops.
 *
 * Reliability guarantees:
 *  - A failed AI request never crashes the runtime: the user gets a friendly
 *    message, the error is logged, the poll loop continues.
 *  - A Telegram send failure never crashes the runtime.
 *  - Token verification (getMe) happens before the loop starts; failure puts
 *    the bot in `error` state with a clear, secret-free statusDetail.
 *  - Cooperative shutdown via AbortController; in-flight AI calls are cancelled.
 */

import { TelegramAdapter, TelegramApiError } from '../telegram/adapter';
import { handleBotMessage, updateToInboundMessage } from './pipeline';
import { RuntimeBotRecord, RuntimeStore } from './store';
import { BotStatus } from './state-machine';
import type { selectProvider } from '../ai/registry';

export type { BotStatus };

export interface BotRuntimeDeps {
  store: RuntimeStore;
  /** Injectable adapter factory (tests use a fake Telegram). */
  adapterFactory?: (token: string) => TelegramAdapter;
  /** Injectable provider selector (tests use fake providers). */
  providerSelector?: typeof selectProvider;
  /** Max poll-loop error backoff (ms). */
  maxBackoffMs?: number;
}

export class BotRuntime {
  readonly botId: string;
  private record: RuntimeBotRecord;
  private readonly store: RuntimeStore;
  private readonly adapterFactory: (token: string) => TelegramAdapter;
  private readonly providerSelector?: typeof selectProvider;
  private readonly maxBackoffMs: number;

  private abortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private _status: BotStatus = 'stopped';

  constructor(record: RuntimeBotRecord, deps: BotRuntimeDeps) {
    this.botId = record.id;
    this.record = record;
    this.store = deps.store;
    this.adapterFactory = deps.adapterFactory ?? ((token) => new TelegramAdapter({ token }));
    this.providerSelector = deps.providerSelector;
    this.maxBackoffMs = deps.maxBackoffMs ?? 30_000;
  }

  get status(): BotStatus {
    return this._status;
  }

  /** Start the bot: verify Telegram identity, then launch the poll loop. */
  async start(): Promise<void> {
    if (this._status === 'running' || this._status === 'starting') return;

    if (!this.record.enabled) {
      await this.markError('Bot is disabled. Enable it in the dashboard before starting.');
      throw new Error('Bot is disabled');
    }

    this._status = 'starting';
    await this.store.updateBotRuntimeState(this.botId, {
      status: 'starting',
      statusDetail: null,
      transport: 'polling',
    });
    await this.store.createLog(this.botId, 'info', 'Starting bot: verifying Telegram identity…', 'BOT_STARTING');

    const adapter = this.adapterFactory(this.record.telegramToken);
    this.abortController = new AbortController();

    try {
      const me = await adapter.getMe({ signal: this.abortController.signal });
      await adapter.deleteWebhook({ signal: this.abortController.signal });
      this._status = 'running';
      await this.store.updateBotRuntimeState(this.botId, {
        status: 'running',
        statusDetail: null,
        telegramUsername: me.username ? `@${me.username}` : null,
        lastStartedAt: new Date(),
      });
      await this.store.createLog(
        this.botId,
        'info',
        `Bot is running as ${me.username ? '@' + me.username : me.id} (provider: ${this.record.provider}, model: ${this.record.model}, transport: polling).`,
        'BOT_STARTED',
      );
    } catch (err) {
      const detail = err instanceof TelegramApiError
        ? err.message
        : `Failed to start bot: ${err instanceof Error ? err.message : String(err)}`;
      await this.markError(detail);
      this.abortController.abort();
      throw new Error(detail);
    }

    // Background poll loop — failures inside are caught and logged, never thrown.
    this.pollPromise = this.pollLoop(adapter).catch(() => undefined);
  }

  /** Graceful stop: cancel long-poll + in-flight AI requests. */
  async stop(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'stopping') return;
    this._status = 'stopping';
    await this.store.updateBotRuntimeState(this.botId, { status: 'stopping' });
    await this.store.createLog(this.botId, 'info', 'Stopping bot…', 'BOT_STOPPING');
    this.abortController?.abort();
    if (this.pollPromise) {
      await Promise.race([this.pollPromise, sleep(3000)]);
      this.pollPromise = null;
    }
    this._status = 'stopped';
    await this.store.updateBotRuntimeState(this.botId, { status: 'stopped', statusDetail: null });
    await this.store.createLog(this.botId, 'info', 'Bot stopped.', 'BOT_STOPPED');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Internal: long-poll loop with retry/backoff. */
  private async pollLoop(adapter: TelegramAdapter): Promise<void> {
    const signal = this.abortController!.signal;
    let offset = 0;
    let consecutiveErrors = 0;

    while (!signal.aborted && this._status === 'running') {
      try {
        const updates = await adapter.getUpdates(offset, { signal });
        consecutiveErrors = 0;
        for (const update of updates) {
          if (signal.aborted) return;
          offset = Math.max(offset, update.update_id + 1);
          const msg = updateToInboundMessage(update);
          if (!msg) continue;
          await this.store.createLog(
            this.botId,
            'info',
            `Message received from chat ${msg.chatId} (${msg.text?.length ?? 0} chars).`,
            'TELEGRAM_MESSAGE_RECEIVED',
          );
          await handleBotMessage(this.record, adapter, msg, {
            store: this.store,
            signal,
            providerSelector: this.providerSelector,
          });
        }
      } catch (err) {
        if (signal.aborted) return;

        if (err instanceof TelegramApiError) {
          if (!err.retryable) {
            // invalid_token / conflict: unrecoverable — put bot into error state.
            await this.markError(err.message);
            this._status = 'error';
            return;
          }
          consecutiveErrors += 1;
          const delay = err.retryAfterMs ?? this.backoff(consecutiveErrors);
          await this.store.createLog(this.botId, 'warn', `Telegram poll error (will retry): ${err.message}`);
          await sleepCancellable(delay, signal);
          continue;
        }

        consecutiveErrors += 1;
        await this.store.createLog(
          this.botId,
          'warn',
          `Poll loop error (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleepCancellable(this.backoff(consecutiveErrors), signal);
      }
    }
  }

  private backoff(n: number): number {
    return Math.min(1000 * 2 ** Math.max(0, n - 1), this.maxBackoffMs);
  }

  private async markError(detail: string): Promise<void> {
    this._status = 'error';
    await this.store.updateBotRuntimeState(this.botId, { status: 'error', statusDetail: detail });
    await this.store.createLog(this.botId, 'error', detail, 'BOT_ERROR');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
