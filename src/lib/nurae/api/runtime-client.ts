/**
 * NURAE — internal client for the bot runtime service (localhost:3030).
 *
 * The Next.js API process never runs Telegram polling itself; it proxies
 * lifecycle actions to the isolated runtime process. The shared internal
 * token protects the runtime even though the sandbox gateway can reach it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

function runtimePort(): number {
  return Number(process.env.NURAE_RUNTIME_PORT || 3030);
}

function runtimeToken(): string {
  if (process.env.NURAE_RUNTIME_TOKEN) return process.env.NURAE_RUNTIME_TOKEN;
  const tokenPath = join(process.cwd(), 'db', '.nurae-runtime-token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }
  return '';
}

const RUNTIME_TIMEOUT_MS = Number(process.env.NURAE_RUNTIME_TIMEOUT_MS || 60_000);

async function call<T>(path: string, init?: RequestInit): Promise<RuntimeCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${runtimePort()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtimeToken()}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[NURAE] runtime call failed (${path}): ${message}`);
    return { ok: false, status: 503, data: null };
  } finally {
    clearTimeout(timer);
  }
}

export const runtimeClient = {
  health: () => call<{ name: string; version: string; uptimeSec: number; managedBots: number }>('/health'),
  start: (botId: string) => call<{ botId: string; status: string }>(`/bots/${botId}/start`, { method: 'POST' }),
  stop: (botId: string) => call<{ botId: string; status: string }>(`/bots/${botId}/stop`, { method: 'POST' }),
  restart: (botId: string) => call<{ botId: string; status: string }>(`/bots/${botId}/restart`, { method: 'POST' }),
  status: (botId: string) => call<{ botId: string; status: string; startedAt: number | null }>(`/bots/${botId}/status`),
  listStatuses: () => call<{ bots: Array<{ botId: string; status: string; startedAt: number | null }> }>('/status'),
};

/** Friendly error for API routes when the runtime process cannot be reached. */
export function runtimeUnavailable(): NextResponseLike {
  return {
    status: 503,
    body: {
      error:
        'NURAE runtime service is not reachable. Ensure the runtime process is running (mini-services/nurae-runtime).',
    },
  };
}

export interface NextResponseLike {
  status: number;
  body: Record<string, unknown>;
}
