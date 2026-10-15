/**
 * NURAE - platform AI key health.
 *
 * Answers "can the platform AI layer (agents, official bots) actually call its
 * provider right now?" with a cached, secret-free probe. Used by the admin
 * dashboard banner and GET /api/ai-health so a dead provider key is visible
 * BEFORE users hit "the AI layer rejected its credentials".
 */

import { selectProvider } from './registry';
import { getOfficialBot } from '../auth/official-bot';

export type AiKeyStatus = 'ok' | 'invalid' | 'missing' | 'unreachable' | 'unconfigured';

export interface AiKeyHealth {
  status: AiKeyStatus;
  ok: boolean;
  provider: string | null;
  model: string | null;
  /** Env var the key is read from when the bot has no stored key. */
  envVar: string | null;
  /** Human-readable explanation + the fix. Never contains key material. */
  detail: string;
  checkedAt: string;
}

const TTL_MS = 60_000;
let cache: { at: number; value: AiKeyHealth } | null = null;
let inflight: Promise<AiKeyHealth> | null = null;

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
      detail: 'The official platform bot has not been created yet; restart the server to seed it.',
      checkedAt,
    };
  }
  const selection = selectProvider(bot.provider, { apiKey: null, baseUrl: bot.baseUrl });
  const envVar = selection.info.apiKeyEnvVar;
  let storedKey: string | null = null;
  if (bot.apiKeyRef) {
    try {
      const { SecretManager } = await import('../secrets');
      storedKey = SecretManager.decrypt(bot.apiKeyRef);
    } catch {
      storedKey = null;
    }
  }
  const key = storedKey ?? selection.apiKey;
  const base = { provider: selection.info.id, model: bot.model ?? null, envVar, checkedAt };

  if (selection.info.requiresKey && !key) {
    return {
      ...base,
      status: 'missing',
      ok: false,
      detail: `No API key is configured. Set ${envVar ?? 'the provider key'} in .env and restart the server.`,
    };
  }

  const res = await selection.provider.validateCredentials({
    apiKey: key,
    baseUrl: selection.baseUrl,
    model: bot.model,
  });
  if (res.valid) {
    return { ...base, status: 'ok', ok: true, detail: 'The AI provider accepted the platform key.' };
  }
  const rejected = /reject|401|403|invalid|expired|not found/i.test(res.detail ?? '');
  if (rejected) {
    return {
      ...base,
      status: 'invalid',
      ok: false,
      detail: `${selection.info.label.split(' ')[0]} rejected the platform key (it was revoked, deleted or mistyped). Create a new key, put it in ${envVar ?? '.env'} and restart the server.`,
    };
  }
  return {
    ...base,
    status: 'unreachable',
    ok: false,
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
