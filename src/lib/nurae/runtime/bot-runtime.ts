/**
 * NURAE — BotRuntime (spec §9, §11, §16, §17).
 *
 * Owns exactly ONE bot: Telegram long-poll loop → command routing → memory
 * window → Provider Selector → AI Provider → reply via Telegram.
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
import { selectProvider } from '../ai/registry';
import { AIError, ChatMessage } from '../ai/types';
import { RuntimeBotRecord, RuntimeStore } from './store';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface BotRuntimeDeps {
  store: RuntimeStore;
  /** Injectable adapter factory (tests use a fake Telegram). */
  adapterFactory?: (token: string) => TelegramAdapter;
  /** Injectable provider selector (tests use fake providers). */
  providerSelector?: typeof selectProvider;
  /** Max poll-loop error backoff (ms). */
  maxBackoffMs?: number;
}

const START_TEXT = (botName: string) =>
  `${botName} is online ✅\n\nI am an AI assistant powered by NURAE (FRAZIYM TECH & AI).\nSend me any message and I will reply.\nUse /help to see available commands.`;

const HELP_TEXT =
  'Available commands:\n' +
  '/start — check that the bot is online\n' +
  '/help — show this help\n\n' +
  'Anything else you send is handled by the AI assistant.';

const AI_FAILURE_TEXT: Record<string, string> = {
  invalid_credentials: 'The AI provider rejected the credentials. The bot owner has been notified via logs.',
  missing_credentials: 'The AI provider is not configured yet. Please add an API key in the dashboard.',
  rate_limited: 'The AI provider is rate-limiting requests right now. Please try again in a moment.',
  timeout: 'The AI request timed out. Please try again.',
  provider_not_found: 'The configured AI provider is unknown. Please check the bot configuration.',
  network_error: 'Could not reach the AI provider. Please try again shortly.',
  api_error: 'The AI provider returned an error. Please try again shortly.',
  invalid_response: 'The AI provider returned an unexpected response. Please try again.',
};

export class BotRuntime {
  readonly botId: string;
  private record: RuntimeBotRecord;
  private readonly store: RuntimeStore;
  private readonly adapterFactory: (token: string) => TelegramAdapter;
  private readonly providerSelector: typeof selectProvider;
  private readonly maxBackoffMs: number;

  private abortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private _status: BotStatus = 'stopped';

  constructor(record: RuntimeBotRecord, deps: BotRuntimeDeps) {
    this.botId = record.id;
    this.record = record;
    this.store = deps.store;
    this.adapterFactory = deps.adapterFactory ?? ((token) => new TelegramAdapter({ token }));
    this.providerSelector = deps.providerSelector ?? selectProvider;
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
    await this.store.updateBotRuntimeState(this.botId, { status: 'starting', statusDetail: null });
    await this.store.createLog(this.botId, 'info', 'Starting bot: verifying Telegram identity…');

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
        `Bot is running as ${me.username ? '@' + me.username : me.id} (provider: ${this.record.provider}, model: ${this.record.model}).`,
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
    this.abortController?.abort();
    if (this.pollPromise) {
      await Promise.race([this.pollPromise, sleep(3000)]);
      this.pollPromise = null;
    }
    this._status = 'stopped';
    await this.store.updateBotRuntimeState(this.botId, { status: 'stopped', statusDetail: null });
    await this.store.createLog(this.botId, 'info', 'Bot stopped.');
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
          if (update.message?.text) {
            await this.handleMessage(adapter, update.message.chat.id, update.message.text, update.message.from?.is_bot ?? false);
          }
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

  /** Command routing + AI pipeline (spec §16). */
  private async handleMessage(
    adapter: TelegramAdapter,
    chatId: number,
    text: string,
    fromBot: boolean,
  ): Promise<void> {
    if (fromBot) return; // ignore bots to avoid loops
    const trimmed = text.trim();
    if (!trimmed) return;

    // Command routing
    if (trimmed === '/start') {
      await this.sendSafely(adapter, chatId, START_TEXT(this.record.name));
      await this.store.createLog(this.botId, 'info', `Handled /start for chat ${chatId}.`);
      return;
    }
    if (trimmed === '/help') {
      await this.sendSafely(adapter, chatId, HELP_TEXT);
      await this.store.createLog(this.botId, 'info', `Handled /help for chat ${chatId}.`);
      return;
    }
    if (trimmed.startsWith('/')) {
      await this.sendSafely(adapter, chatId, `Unknown command "${trimmed.split(/\s+/)[0]}".\n\n${HELP_TEXT}`);
      return;
    }

    // --- AI pipeline -------------------------------------------------------
    await this.store.appendUserMessage(this.botId, String(chatId), trimmed);
    const history = await this.store.getRecentMessages(this.botId, String(chatId), this.record.memorySize);
    const messages: ChatMessage[] = [
      { role: 'system', content: this.record.systemPrompt },
      ...history,
    ];

    let reply: string;
    try {
      const selection = this.providerSelector(this.record.provider, {
        apiKey: this.record.apiKey,
        baseUrl: this.record.baseUrl,
      });
      if (selection.info.requiresKey && !selection.apiKey) {
        throw new AIError('missing_credentials', `No API key configured for provider "${selection.info.id}".`);
      }
      reply = await selection.provider.generate(messages, {
        model: this.record.model,
        temperature: this.record.temperature,
        maxTokens: this.record.maxTokens,
        apiKey: selection.apiKey,
        baseUrl: selection.baseUrl,
        signal: this.abortController?.signal,
      });
    } catch (err) {
      const aiErr = err instanceof AIError ? err : null;
      const message = aiErr ? `${aiErr.code}: ${aiErr.message}` : err instanceof Error ? err.message : String(err);
      await this.store.createLog(this.botId, 'error', `AI request failed — ${message}`);
      const friendly =
        AI_FAILURE_TEXT[aiErr?.code ?? 'api_error'] ?? AI_FAILURE_TEXT.api_error;
      await this.sendSafely(adapter, chatId, `⚠️ ${friendly}`);
      return;
    }

    await this.store.appendAssistantMessage(this.botId, String(chatId), reply);
    if (this.record.memorySize > 0) {
      await this.store.trimConversation(this.botId, String(chatId), this.record.memorySize);
    }
    await this.sendSafely(adapter, chatId, reply);
    await this.store.createLog(this.botId, 'info', `Replied to chat ${chatId} (${reply.length} chars).`);
  }

  private async sendSafely(adapter: TelegramAdapter, chatId: number, text: string): Promise<void> {
    try {
      await adapter.sendMessage(chatId, text, { signal: this.abortController?.signal });
    } catch (err) {
      if (err instanceof TelegramApiError) {
        await this.store.createLog(this.botId, 'warn', `Telegram send failed for chat ${chatId}: ${err.message}`);
      } else {
        await this.store.createLog(
          this.botId,
          'warn',
          `Telegram send failed for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async markError(detail: string): Promise<void> {
    this._status = 'error';
    await this.store.updateBotRuntimeState(this.botId, { status: 'error', statusDetail: detail });
    await this.store.createLog(this.botId, 'error', detail);
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
