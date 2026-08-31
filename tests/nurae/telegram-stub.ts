/**
 * NURAE — shared Telegram Bot API + AI stub (single global fetch patch).
 *
 * Idempotent: install once per test process. Both api.test.ts and
 * webhook.test.ts import this, so lifecycle and webhook-ingestion flows run
 * against the same stateful fake (no real network, no real credentials).
 */

const REAL_FETCH = globalThis.fetch;

export const TELEGRAM_STUB_BASE = 'http://127.0.0.1:39998';
export const STUB_TELEGRAM_TOKEN = '1234567890:AAValidFormatTokenForTesting1234';

export interface TelegramStubState {
  mode: 'ok' | 'invalid-token';
  /** Every Telegram Bot API method call, in order. */
  log: Array<{ method: string; body: Record<string, unknown> }>;
  /** Webhook registry: token → registered webhook (url + secret). */
  registry: Map<string, { url: string; secret: string }>;
  /** Outbound sendMessage calls captured (chatId as string, text). */
  sends: Array<{ chatId: string; text: string }>;
}

export const telegramState: TelegramStubState = {
  mode: 'ok',
  log: [],
  registry: new Map(),
  sends: [],
};

let installed = false;

export function installTelegramStub(): void {
  if (installed) return;
  installed = true;
  process.env.NURAE_TELEGRAM_API_BASE = TELEGRAM_STUB_BASE;

  function tgRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${TELEGRAM_STUB_BASE}/bot`)) {
      const m = /^.*\/bot([^/]+)\/(\w+)$/.exec(url);
      const token = m?.[1] ?? '';
      const method = m?.[2] ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      telegramState.log.push({ method, body });

      if (telegramState.mode === 'invalid-token' && method === 'getMe') {
        return tgRes({ ok: false, error_code: 401, description: 'Unauthorized' });
      }
      if (method === 'getMe') return tgRes({ ok: true, result: { id: 42, username: 'stub_bot', first_name: 'Stub' } });
      if (method === 'setWebhook') {
        telegramState.registry.set(token, { url: String(body.url), secret: String(body.secret_token ?? '') });
        return tgRes({ ok: true, result: true });
      }
      if (method === 'getWebhookInfo') {
        const wh = telegramState.registry.get(token);
        return tgRes({
          ok: true,
          result: { url: wh?.url ?? '', has_custom_certificate: false, pending_update_count: 0 },
        });
      }
      if (method === 'deleteWebhook') {
        telegramState.registry.delete(token);
        return tgRes({ ok: true, result: true });
      }
      if (method === 'sendMessage') {
        telegramState.sends.push({ chatId: String(body.chat_id), text: String(body.text) });
        return tgRes({ ok: true, result: { message_id: 1 } });
      }
      return tgRes({ ok: false, error_code: 404, description: `Unknown method ${method}` });
    }

    // OpenAI-compatible AI stub: any chat completion returns a fixed reply.
    if (url.includes('/chat/completions')) {
      return tgRes({ choices: [{ message: { content: 'stubbed AI reply' } }] });
    }
    if (url.includes('/models')) {
      return tgRes({ data: [] });
    }

    return REAL_FETCH(input as Request, init);
  }) as typeof fetch;
}

export function resetTelegramStub(): void {
  telegramState.mode = 'ok';
  telegramState.log.length = 0;
  telegramState.registry.clear();
  telegramState.sends.length = 0;
}
