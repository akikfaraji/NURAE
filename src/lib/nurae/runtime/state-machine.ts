/**
 * NURAE — bot status state machine (spec Step 8).
 *
 * Bots have five reliable states. Nonsense transitions are rejected here so
 * the persisted status can never become contradictory, even if two API calls
 * race (the transition is enforced again at the database level).
 *
 *   STOPPED ──▶ STARTING ──▶ RUNNING ──▶ STOPPING ──▶ STOPPED
 *                  │             │            │
 *                  ▼             ▼            ▼
 *                ERROR         ERROR        ERROR
 *
 *   ERROR ──▶ STARTING (operator retries via start/restart)
 *   STOPPED ──▶ ERROR (verification failures surfaced while idle)
 */

export const BOT_STATUSES = ['stopped', 'starting', 'running', 'stopping', 'error'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

const ALLOWED: Record<BotStatus, readonly BotStatus[]> = {
  stopped: ['starting', 'error'],
  starting: ['running', 'error', 'stopping'],
  running: ['stopping', 'error'],
  stopping: ['stopped', 'error'],
  error: ['starting', 'stopped'],
};

export function isBotStatus(value: string): value is BotStatus {
  return (BOT_STATUSES as readonly string[]).includes(value);
}

/** True when `from → to` is a legal transition. */
export function canTransition(from: string, to: BotStatus): boolean {
  if (!isBotStatus(from)) return false;
  return ALLOWED[from].includes(to);
}

/** Human-readable list of legal targets — used in error messages. */
export function legalTransitions(from: string): readonly BotStatus[] {
  if (!isBotStatus(from)) return [];
  return ALLOWED[from];
}
