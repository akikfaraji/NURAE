/**
 * NURAE - platform AI key health.
 *
 * Answers "can the platform AI layer (agents, official bots) actually call its
 * provider right now?" with a cached, secret-free probe. Used by the admin
 * dashboard banner and GET /api/ai-health so a dead provider key is visible
 * BEFORE users hit "the AI layer rejected its credentials".
 *
 * Precision matters here: a STORED per-bot key always overrides the .env
 * fallback (selectProvider), so the fix advice MUST name the source that was
 * actually probed. Telling an owner to "put the new key in .env" while a dead
 * stored key keeps winning is exactly the loop that makes owners report
 * "the new key doesn't work" when the new key was simply never used.
 */

import { selectProvider } from './registry';
import { getOfficialBot } from '../auth/official-bot';

export type AiKeyStatus = 'ok' | 'invalid' | 'missing' | 'unreadable' | 'unreachable' | 'unconfigured';
export type AiKeySource = 'stored' | 'env' | null;

export interface AiKeyHealth {
  status: AiKeyStatus;
  ok: boolean;
  provider: string | null;
  model: string | null;
  /** Env var the key is read from when the bot has no stored key. */
  envVar: string | null;
  /** Where the probed key came from: the bot's stored settings or the .env fallback. */
  keySource: AiKeySource;
  /** True when a stored credential exists but could not be decrypted (encryption key changed). */
  storedUnreadable: boolean;
  /** Human-readable explanation + the fix. Never contains key material. */
  detail: string;
  checkedAt: string;
}

const TTL_MS = 60_000;
let cache: { at: number; value: AiKeyHealth } | null = null;
let inflight: Promise<AiKeyHealth> | null = null;

const UNREADABLE_DETAIL =
  'The bot has a stored AI key, but it cannot be decrypted any more — the encryption key changed ' +
  '(NURAE_SECRET_KEY was rotated, or the database path moved). Stored keys override the .env fallback, ' +
  'so editing .env alone will NOT fix this: open the bot in the dashboard, re-enter the API key in its ' +
  'settings (this re-encrypts it with the current key), then re-check.';

const STORED_REJECTED_DETAIL =
  'The key stored in the bot\u2019s settings was rejected — and a stored key ALWAYS overrides the .env ' +
  'fallback, so adding the new key to .env changes nothing. Open the bot in the dashboard and save the ' +
  'new key in its settings (or clear the stored key to fall back to .env), then re-check.';

async function probe(): Promise<AiKeyHealth> {
  const checkedAt = new Date().toISOString();
  const bot = await getOfficialBot();
  if (!bot) {
    return {
      status: 'unconfigured',
      ok: false,
      provider: null,
      model: null,
      envVar: null,
      keySource: null,
      storedUnreadable: false,
      detail: 'The official platform bot has not been created yet; restart the server to seed it.',
      checkedAt,
    };
  }
  const selection = selectProvider(bot.provider, { apiKey: null, baseUrl: bot.baseUrl });
  const envVar = selection.info.apiKeyEnvVar;
  const envKey = selection.apiKey;
  let storedKey: string | null = null;
  let storedUnreadable = false;
  if (bot.apiKeyRef) {
    try {
      const { SecretManager } = await import('../secrets');
      storedKey = SecretManager.decrypt(bot.apiKeyRef);
    } catch {
      storedKey = null;
      storedUnreadable = true;
    }
  }
  const key = storedKey ?? envKey;
  const base = {
    provider: selection.info.id,
    model: bot.model ?? null,
    envVar,
    checkedAt,
  };

  if (selection.info.requiresKey && !key) {
    return {
      ...base,
      status: 'missing',
      ok: false,
      keySource: null,
      storedUnreadable,
      detail: `No API key is configured. Set ${envVar ?? 'the provider key'} in .env and restart the server.`,
    };
  }

  // A stored credential that cannot be decrypted is a broken state no provider
  // probe can paper over: even if the .env fallback validates, every runtime
  // path that prefers the stored key is dead. Say so instead of probing.
  if (storedUnreadable) {
    return {
      ...base,
      status: 'unreadable',
      ok: false,
      keySource: 'stored',
      storedUnreadable: true,
      detail: UNREADABLE_DETAIL,
    };
  }

  const keySource: AiKeySource = storedKey ? 'stored' : 'env';
  const res = await selection.provider.validateCredentials({
    apiKey: key,
    baseUrl: selection.baseUrl,
    model: bot.model,
  });
  if (res.valid) {
    return { ...base, status: 'ok', ok: true, keySource, storedUnreadable, detail: 'The AI provider accepted the platform key.' };
  }
  const rejected = /reject|401|403|invalid|expired|not found/i.test(res.detail ?? '');
  if (rejected) {
    return {
      ...base,
      status: 'invalid',
      ok: false,
      keySource,
      storedUnreadable,
      detail:
        keySource === 'stored'
          ? `${selection.info.label.split(' ')[0]} rejected the stored platform key (revoked, deleted or mistyped). ${STORED_REJECTED_DETAIL}`
          : `${selection.info.label.split(' ')[0]} rejected the platform key (it was revoked, deleted or mistyped). Create a new key, put it in ${envVar ?? '.env'} and restart the server.`,
    };
  }
  return {
    ...base,
    status: 'unreachable',
    ok: false,
    keySource,
    storedUnreadable,
    detail: res.detail ?? 'Could not reach the AI provider. Check the server\u2019s internet connection.',
  };
}

/** Cached for 60 s; concurrent callers share one probe. `force` bypasses the cache. */
export async function getAiKeyHealth(force = false): Promise<AiKeyHealth> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (!inflight) {
    inflight = probe()
      .catch(
        (err): AiKeyHealth => ({
          status: 'unreachable',
          ok: false,
          provider: null,
          model: null,
          envVar: null,
          keySource: null,
          storedUnreadable: false,
          detail: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
          checkedAt: new Date().toISOString(),
        }),
      )
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
