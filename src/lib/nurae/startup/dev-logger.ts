/**
 * NURAE — dev.log: one file that captures EVERY error the server produces.
 *
 * Why this exists: the owner kept finding out about breakage from symptoms
 * (a bot that will not start, a banner in the dashboard) with no way to
 * answer "what broke?". Next.js prints to stdout/stderr, which on Windows
 * vanishes the moment the terminal closes. This module mirrors every
 * console.error / console.warn call — Next.js request errors, Prisma errors,
 * AI provider failures, bot runtime errors, boot failures — plus unhandled
 * promise rejections, into ONE append-only file under the data root:
 *
 *   Windows:  %LOCALAPPDATA%\FRAZIYM\NURAE\logs\dev.log
 *   Linux:    <project root>/logs/dev.log
 *
 * Design rules:
 *  - enabled by default (NURAE_DEV_LOG=0 opts out); disabled in vitest runs
 *    unless explicitly forced on, so test output stays clean;
 *  - writes are synchronous appends with a kept-open fd — ordering matters
 *    more than throughput for an error log, and a crashed process must not
 *    lose its last error;
 *  - the logger NEVER throws and NEVER calls console.* — a failing log file
 *    (disk full, permissions) silently disables capture instead of breaking
 *    the server or recursing;
 *  - rotates at 5 MB: dev.log → dev.log.1 (one previous generation kept);
 *  - no process-level uncaughtException listener is installed: hijacking
 *    Node's crash semantics from a logger is a footgun — everything the app
 *    reports still goes through console.error and is captured; a hard crash
 *    additionally prints to the terminal the launcher runs in.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatWithOptions } from 'node:util';
import { resolveDataPath } from '@/lib/paths';
import { NURAE_VERSION } from '../version';

const ROTATE_BYTES = 5 * 1024 * 1024;

interface DevLoggerState {
  fd: number | null;
  disabled: boolean;
  installed: boolean;
  originalError: typeof console.error;
  originalWarn: typeof console.warn;
  rejectionHandler: ((err: unknown, promise: Promise<unknown>) => void) | null;
}

const state: DevLoggerState = {
  fd: null,
  disabled: false,
  installed: false,
  originalError: console.error,
  originalWarn: console.warn,
  rejectionHandler: null,
};

/** The one dev.log path (data root → logs/dev.log). */
export function devLogPath(): string {
  return resolveDataPath(join('logs', 'dev.log'));
}

function devLogEnabled(): boolean {
  const flag = process.env.NURAE_DEV_LOG?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return process.env.NODE_ENV !== 'test'; // default: on, quiet in vitest
}

function ensureFd(): number | null {
  if (state.fd !== null) return state.fd;
  if (state.disabled) return null;
  try {
    const path = devLogPath();
    mkdirSync(dirname(path), { recursive: true });
    // Rotate once per boot-open when the previous run filled the file.
    if (existsSync(path) && statSync(path).size > ROTATE_BYTES) {
      const prev = `${path}.1`;
      try {
        if (existsSync(prev)) unlinkSync(prev);
      } catch {
        /* rotation is best-effort */
      }
      try {
        renameSync(path, prev);
      } catch {
        /* Windows may refuse if a viewer holds the file — keep appending */
      }
    }
    state.fd = openSync(path, 'a');
    return state.fd;
  } catch {
    state.disabled = true; // unreadable dir / disk full → fail quiet, forever
    return null;
  }
}

/** Serialize console args exactly like the console would (safe on any input). */
function formatArgs(args: unknown[]): string {
  try {
    return formatWithOptions({ depth: 6, breakLength: 200 }, ...args);
  } catch {
    return args
      .map((a) => {
        try {
          return typeof a === 'string' ? a : JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  }
}

function appendLine(level: string, args: unknown[]): void {
  const fd = ensureFd();
  if (fd === null) return;
  try {
    const ts = new Date().toISOString();
    appendFileSync(fd, `[${ts}] [${level}] ${formatArgs(args)}\n`);
  } catch {
    state.disabled = true;
    try {
      closeSync(fd);
    } catch {
      /* nothing left to do */
    }
    state.fd = null;
  }
}

function bootHeader(): void {
  const fd = ensureFd();
  if (fd === null) return;
  try {
    appendFileSync(
      fd,
      `\n[${new Date().toISOString()}] [boot] NURAE ${NURAE_VERSION} · node ${process.version} · ${process.platform} ${process.arch} · pid ${process.pid}\n`,
    );
  } catch {
    /* header is best-effort */
  }
}

/**
 * Mirror every console.error / console.warn into dev.log and capture
 * unhandled promise rejections. Idempotent: a second call is a no-op.
 */
export function installDevLogger(): void {
  if (state.installed) return;
  state.installed = true;
  if (!devLogEnabled()) {
    state.disabled = true;
    return;
  }
  // Capture the CURRENT console at install time (not module-eval time) so
  // install/uninstall nest correctly around anything that patched console
  // before us (test spies, other loggers).
  state.originalError = console.error;
  state.originalWarn = console.warn;
  bootHeader();

  console.error = (...args: unknown[]) => {
    appendLine('error', args);
    state.originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendLine('warn', args);
    state.originalWarn(...args);
  };

  state.rejectionHandler = (err: unknown) => {
    appendLine('unhandledRejection', [
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    ]);
  };
  process.on('unhandledRejection', state.rejectionHandler);
}

/** Test escape hatch: restore originals, close the fd, drop listeners. */
export function uninstallDevLogger(): void {
  if (!state.installed) return;
  console.error = state.originalError;
  console.warn = state.originalWarn;
  if (state.rejectionHandler) {
    process.off('unhandledRejection', state.rejectionHandler);
    state.rejectionHandler = null;
  }
  if (state.fd !== null) {
    try {
      closeSync(state.fd);
    } catch {
      /* already closed */
    }
    state.fd = null;
  }
  state.installed = false;
  state.disabled = false;
}
