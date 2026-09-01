import { describe, expect, test } from 'vitest';
import { BotManager } from '../../src/lib/nurae/runtime/bot-manager';
import { BotRuntime } from '../../src/lib/nurae/runtime/bot-runtime';
import { TelegramApiError } from '../../src/lib/nurae/telegram/adapter';
import type { RuntimeBotRecord, RuntimeStore } from '../../src/lib/nurae/runtime/store';
import { makeStore, runtimeRecord } from './telegram.test';

function makeIdleAdapter(failStart = false) {
  const controller = new AbortController();
  return {
    async getMe() {
      if (failStart) {
        throw new TelegramApiError('invalid_token', 'Telegram rejected the bot token (401).');
      }
      return { id: 7, username: 'idle_bot' };
    },
    async deleteWebhook() {},
    async getUpdates(_offset: number, o?: { signal?: AbortSignal }) {
      return new Promise<never[]>((resolve) => {
        o?.signal?.addEventListener('abort', () => resolve([]), { once: true });
      });
    },
    async sendMessage() {},
  };
}

describe('BotManager — lifecycle & isolation (spec §14, §17)', () => {
  test('start / status / stop transitions', async () => {
    const ms = makeStore();
    const record = runtimeRecord();
    ms.bots.set(record.id, record);

    const manager = new BotManager({
      store: ms.store,
      runtimeFactory: (rec) =>
        new BotRuntime(rec, {
          store: ms.store,
          adapterFactory: () => makeIdleAdapter() as never,
        }),
    });

    const started = await manager.startBot(record.id);
    expect(started.status).toBe('running');
    expect(manager.statusOf(record.id).status).toBe('running');
    expect(ms.state.get(record.id)?.status).toBe('running');
    expect(ms.state.get(record.id)?.username).toBe('@idle_bot');

    const stopped = await manager.stopBot(record.id);
    expect(stopped.status).toBe('stopped');
    expect(ms.state.get(record.id)?.status).toBe('stopped');
  });

  test('restart re-reads configuration from the store', async () => {
    const ms = makeStore();
    const record = runtimeRecord();
    ms.bots.set(record.id, record);

    let created = 0;
    const manager = new BotManager({
      store: ms.store,
      runtimeFactory: (rec) => {
        created += 1;
        return new BotRuntime(rec, {
          store: ms.store,
          adapterFactory: () => makeIdleAdapter() as never,
        });
      },
    });

    await manager.startBot(record.id);
    // Simulate a configuration change (e.g. new model) done via the API.
    ms.bots.set(record.id, { ...record, model: 'new-model-x' });
    await manager.restartBot(record.id);
    expect(created).toBe(2); // a fresh runtime was built with the new config
  });

  test('multiple bots run simultaneously (spec §14)', async () => {
    const ms = makeStore();
    const recA = runtimeRecord({ id: 'bot-a' });
    const recB = runtimeRecord({ id: 'bot-b' });
    ms.bots.set(recA.id, recA);
    ms.bots.set(recB.id, recB);

    const manager = new BotManager({
      store: ms.store,
      runtimeFactory: (rec) =>
        new BotRuntime(rec, {
          store: ms.store,
          adapterFactory: () => makeIdleAdapter() as never,
        }),
    });

    await manager.startBot(recA.id);
    await manager.startBot(recB.id);
    expect(manager.isManaged(recA.id)).toBe(true);
    expect(manager.isManaged(recB.id)).toBe(true);
    expect(manager.listStatuses().map((s) => s.status)).toEqual(['running', 'running']);

    // Stopping one does not affect the other.
    await manager.stopBot(recA.id);
    expect(manager.isManaged(recA.id)).toBe(false);
    expect(manager.isManaged(recB.id)).toBe(true);
    await manager.stopAll();
  });

  test('a failing bot enters error state without crashing the manager', async () => {
    const ms = makeStore();
    const good = runtimeRecord({ id: 'bot-good' });
    const bad = runtimeRecord({ id: 'bot-bad', telegramToken: '9999999999:BrokenTokenButWellFormedXxxxxx' });
    ms.bots.set(good.id, good);
    ms.bots.set(bad.id, bad);

    const manager = new BotManager({
      store: ms.store,
      runtimeFactory: (rec) =>
        new BotRuntime(rec, {
          store: ms.store,
          adapterFactory: () => makeIdleAdapter(rec.id === 'bot-bad') as never,
        }),
    });

    await manager.startBot(good.id);
    await expect(manager.startBot(bad.id)).rejects.toThrow(/401/);
    expect(ms.state.get(bad.id)?.status).toBe('error');
    // The healthy bot is untouched.
    expect(manager.statusOf(good.id).status).toBe('running');
    await manager.stopAll();
  });

  test('start of a missing bot fails clearly', async () => {
    const ms = makeStore();
    const manager = new BotManager({ store: ms.store });
    await expect(manager.startBot('nope')).rejects.toThrow(/not found/i);
  });

  test('stopAll stops every managed bot (graceful shutdown path)', async () => {
    const ms = makeStore();
    const ids = ['bot-1', 'bot-2', 'bot-3'];
    for (const id of ids) ms.bots.set(id, runtimeRecord({ id }));

    const manager = new BotManager({
      store: ms.store,
      runtimeFactory: (rec) =>
        new BotRuntime(rec, {
          store: ms.store,
          adapterFactory: () => makeIdleAdapter() as never,
        }),
    });
    for (const id of ids) await manager.startBot(id);
    await manager.stopAll();
    expect(manager.listStatuses().length).toBe(0);
    for (const id of ids) {
      expect(ms.state.get(id)?.status).toBe('stopped');
    }
  });
});
