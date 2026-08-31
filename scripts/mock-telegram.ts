/**
 * NURAE — mock Telegram Bot API for local E2E testing (Step 14).
 *
 * Implements the methods NURAE uses (getMe, setWebhook, deleteWebhook,
 * getWebhookInfo, sendMessage) and records every call. GET /__dump returns
 * all recorded calls so the E2E driver can assert on them.
 *
 * Usage: bun scripts/mock-telegram.ts   (listens on 127.0.0.1:3131)
 */

interface RecordedCall {
  at: number;
  token: string;
  method: string;
  body: Record<string, unknown>;
}

const calls: RecordedCall[] = [];
const webhooks = new Map<string, { url: string; secret: string }>(); // token → webhook

Bun.serve({
  hostname: '127.0.0.1',
  port: 3131,
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/__dump') {
      return Response.json({ calls, webhooks: [...webhooks.entries()] });
    }
    if (url.pathname === '/__reset') {
      calls.length = 0;
      webhooks.clear();
      return Response.json({ ok: true });
    }

    const m = /\/bot([^/]+)\/(\w+)/.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    const [, token, method] = m;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    calls.push({ at: Date.now(), token, method, body });

    switch (method) {
      case 'getMe':
        // Simulate an invalid token for the E2E error-path test.
        if (token.startsWith('000000000')) {
          return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' });
        }
        return Response.json({ ok: true, result: { id: 9001, username: 'nurae_e2e_bot', first_name: 'NURAE E2E' } });
      case 'setWebhook':
        webhooks.set(token, { url: String(body.url ?? ''), secret: String(body.secret_token ?? '') });
        return Response.json({ ok: true, result: true });
      case 'deleteWebhook':
        webhooks.delete(token);
        return Response.json({ ok: true, result: true });
      case 'getWebhookInfo': {
        const wh = webhooks.get(token);
        return Response.json({
          ok: true,
          result: { url: wh?.url ?? '', has_custom_certificate: false, pending_update_count: 0 },
        });
      }
      case 'sendMessage':
        return Response.json({ ok: true, result: { message_id: calls.length, chat: { id: body.chat_id } } });
      default:
        return Response.json({ ok: true, result: true });
    }
  },
});

console.log('Mock Telegram Bot API listening on http://127.0.0.1:3131 (__dump to inspect)');
