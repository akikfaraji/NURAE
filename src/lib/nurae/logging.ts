/**
 * NURAE — logging service.
 *
 * Persists structured logs (Log table) and mirrors them to the console with
 * the NURAE identity line. All messages pass through the sanitizer so secrets
 * never reach storage or stdout. Designed to be shared by the API process and
 * the bot-runtime process; the Prisma client is injected to keep this module
 * dependency-light and testable.
 */

import { truncateForLog } from './sanitize';
import { identityLine } from './version';

export type LogLevel = 'info' | 'warn' | 'error';

/** Minimal Prisma-client surface used here (structural typing, easy to mock). */
export interface LogStore {
  log: {
    create(args: { data: { botId: string | null; level: string; message: string } }): Promise<unknown>;
  };
}

export interface Logger {
  info(botId: string | null, message: string): Promise<void>;
  warn(botId: string | null, message: string): Promise<void>;
  error(botId: string | null, message: string): Promise<void>;
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

export function createLogger(store: LogStore, opts?: { silent?: boolean }): Logger {
  const echo = (level: LogLevel, botId: string | null, message: string) => {
    if (opts?.silent) return;
    const scope = botId ? `bot:${botId.slice(0, 8)}` : 'core';
    const line = `[${identityLine()}] [${LEVEL_PREFIX[level]}] [${scope}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  const write = async (level: LogLevel, botId: string | null, message: string) => {
    const clean = truncateForLog(message);
    echo(level, botId, clean);
    try {
      await store.log.create({ data: { botId, level, message: clean } });
    } catch (err) {
      // Logging must never take the service down.
      console.error(`[NURAE] log write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    info: (botId, message) => write('info', botId, message),
    warn: (botId, message) => write('warn', botId, message),
    error: (botId, message) => write('error', botId, message),
  };
}
