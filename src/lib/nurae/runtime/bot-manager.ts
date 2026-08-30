/**
 * NURAE — BotManager (spec §14).
 *
 * Owns all BotRuntime instances inside the runtime process. Guarantees:
 *  - Multiple bots run simultaneously and independently.
 *  - A failing bot never crashes unrelated bots (each runtime isolates its
 *    own errors; the manager never lets a rejected promise escape unhandled).
 *  - start() re-reads the latest configuration from the store, so config
 *    changes take effect on the next start/restart.
 */

import { BotRuntime } from './bot-runtime';
import { RuntimeBotRecord, RuntimeStore } from './store';

export interface ManagedBotStatus {
  botId: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  startedAt: number | null;
}

export interface BotManagerDeps {
  store: RuntimeStore;
  runtimeFactory?: (record: RuntimeBotRecord) => BotRuntime;
}

export class BotManager {
  private readonly runtimes = new Map<string, BotRuntime>();
  private readonly startedAt = new Map<string, number>();
  private readonly store: RuntimeStore;
  private readonly runtimeFactory: (record: RuntimeBotRecord) => BotRuntime;

  constructor(deps: BotManagerDeps) {
    this.store = deps.store;
    this.runtimeFactory =
      deps.runtimeFactory ??
      ((record) =>
        new BotRuntime(record, {
          store: this.store,
        }));
  }

  /** Start a bot by id (configuration is re-read from the store). */
  async startBot(botId: string): Promise<ManagedBotStatus> {
    const existing = this.runtimes.get(botId);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return this.snapshot(botId, existing.status);
    }

    const record = await this.store.getBot(botId);
    if (!record) {
      throw new Error(`Bot ${botId} not found`);
    }

    // Stop any stale runtime instance first (e.g. after a config change).
    if (existing) {
      await existing.stop().catch(() => undefined);
      this.runtimes.delete(botId);
    }

    if (!record.enabled) {
      throw new Error('Bot is disabled. Enable it before starting.');
    }

    const runtime = this.runtimeFactory(record);
    this.runtimes.set(botId, runtime);
    await runtime.start();
    this.startedAt.set(botId, Date.now());
    return this.snapshot(botId, runtime.status);
  }

  async stopBot(botId: string): Promise<ManagedBotStatus> {
    const runtime = this.runtimes.get(botId);
    if (runtime) {
      await runtime.stop().catch(async (err) => {
        await this.store.createLog(botId, 'warn', `Stop encountered an error: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.runtimes.delete(botId);
    }
    this.startedAt.delete(botId);
    await this.store.updateBotRuntimeState(botId, { status: 'stopped', statusDetail: null }).catch(() => undefined);
    return { botId, status: 'stopped', startedAt: null };
  }

  async restartBot(botId: string): Promise<ManagedBotStatus> {
    await this.stopBot(botId);
    return this.startBot(botId);
  }

  isManaged(botId: string): boolean {
    return this.runtimes.has(botId);
  }

  statusOf(botId: string): ManagedBotStatus {
    const runtime = this.runtimes.get(botId);
    return this.snapshot(botId, runtime?.status ?? 'stopped');
  }

  listStatuses(): ManagedBotStatus[] {
    return [...this.runtimes.keys()].map((id) => this.statusOf(id));
  }

  /** Stop every bot — used by graceful shutdown (spec §17). */
  async stopAll(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    await Promise.allSettled(ids.map((id) => this.stopBot(id)));
  }

  private snapshot(botId: string, status: ManagedBotStatus['status']): ManagedBotStatus {
    return { botId, status, startedAt: this.startedAt.get(botId) ?? null };
  }
}
