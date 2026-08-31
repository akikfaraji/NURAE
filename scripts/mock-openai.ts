/**
 * NURAE — mock OpenAI-compatible AI provider for CI/local E2E testing.
 *
 * The built-in `zai` GLM provider only works inside the FRAZIYM sandbox, so
 * automated environments (GitHub Actions) run this instead and point bots at
 * it via the `custom` provider (baseUrl = http://127.0.0.1:5151/v1,
 * key from CUSTOM_API_KEY env fallback).
 *
 * Behavior:
 *   - Auth: requires a non-empty `Authorization: Bearer …` header (401 like
 *     the real OpenAI API otherwise) — exercises the provider auth path.
 *   - Reply is DETERMINISTIC and echoes the conversation window:
 *       "MOCK-REPLY: saw <N> user message(s); first: \"…\"; latest: \"…\""
 *     so the E2E driver can assert that (a) the user text reached the
 *     provider and (b) earlier messages are present in follow-up requests
 *     (i.e. the memory window works) without depending on any real model.
 *   - GET /v1/models answers the validateCredentials probe.
 *   - GET /__dump returns recorded calls (parity with mock-telegram.ts).
 *
 * Usage: bun scripts/mock-openai.ts   (listens on 127.0.0.1:5151)
 */

interface RecordedCall {
  at: number;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

const calls: RecordedCall[] = [];
const PORT = Number(process.env.OPENAI_MOCK_PORT || 5151);

interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildReply(messages: ChatMessageLike[]): string {
  const userMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content.trim());
  const first = userMsgs[0] ?? '';
  const latest = userMsgs[userMsgs.length - 1] ?? '';
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  return `MOCK-REPLY: saw ${userMsgs.length} user message(s); first: "${cut(first)}"; latest: "${cut(latest)}". NURAE mock AI is deterministic.`;
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    const auth = req.headers.get('authorization');

    if (url.pathname === '/__dump') {
      return Response.json({ calls });
    }
    if (url.pathname === '/__reset') {
      calls.length = 0;
      return Response.json({ ok: true });
    }

    // Behave like the real API on missing credentials.
    if (!auth || !/^Bearer\s+\S+/.test(auth)) {
      return Response.json(
        { error: { message: 'Missing or malformed Authorization header', type: 'invalid_request_error', code: 'invalid_api_key' } },
        { status: 401 },
      );
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return Response.json({
        object: 'list',
        data: [
          { id: 'mock-model', object: 'model', created: 1700000000, owned_by: 'nurae-mock' },
          { id: 'mock-mini', object: 'model', created: 1700000000, owned_by: 'nurae-mock' },
        ],
      });
    }

    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as
        | { model?: string; messages?: ChatMessageLike[] }
        | null;
      calls.push({ at: Date.now(), path: url.pathname, auth, body });

      const messages = Array.isArray(body?.messages) ? body!.messages! : [];
      const reply = buildReply(messages);
      return Response.json({
        id: `chatcmpl-mock-${calls.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'mock-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0),
          completion_tokens: Math.ceil(reply.length / 4),
          total_tokens: 0,
        },
      });
    }

    return Response.json({ error: { message: `Unknown path: ${url.pathname}`, type: 'invalid_request_error' } }, { status: 404 });
  },
});

console.log(`Mock OpenAI-compatible API listening on http://127.0.0.1:${PORT} (/v1/chat/completions, /v1/models, __dump)`);
