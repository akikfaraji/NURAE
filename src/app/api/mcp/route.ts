/**
 * NURAE — POST /api/mcp: the MCP-style JSON-RPC 2.0 connector surface, so
 * MCP clients (e.g. Claude connectors) can discover and call NURAE tools
 * like any other MCP server.
 *
 * Contract:
 *  - Auth: `Authorization: Bearer nrae_…` (AgentToken). Without the header
 *    → 401 with `WWW-Authenticate: Bearer` and a JSON-RPC error body.
 *  - initialize        → protocolVersion '2025-06-18', capabilities, serverInfo.
 *  - notifications/initialized → 202, empty body.
 *  - tools/list        → { tools: [{ name, description, inputSchema }] }
 *                        (platform-scope tokens also list the operator tier).
 *  - tools/call        → params { name, arguments } — the exact same gated
 *                        execution path as POST /api/v1/tools/call (token
 *                        consequential gate + shared 60/min rate limit),
 *                        shaped as MCP content: { content: [{ type:'text',
 *                        text }], isError }.
 *  - Errors: -32700 parse, -32600 bad envelope, -32601 unknown method,
 *    -32602 bad params, -32603 internal; every response echoes { jsonrpc, id }.
 *
 * GET /api/mcp → 405 with a tiny capability hint.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAgentToken, type AgentTokenRowLike } from '@/lib/nurae/auth/agent-tokens';
import { rateLimit } from '@/lib/nurae/auth/rate-limit';
import { runRemoteToolCall, type RemoteToolOutcome } from '@/lib/nurae/agents/remote-call';
import { toolDescriptors } from '@/lib/nurae/agents/tools';
import { platformToolDescriptors } from '@/lib/nurae/agents/platform-tools';
import { NURAE_VERSION } from '@/lib/nurae/version';

type RpcId = string | number | null;

const JSONRPC = '2.0';

function rpcResult(id: RpcId, result: unknown, status = 200): NextResponse {
  return NextResponse.json({ jsonrpc: JSONRPC, id, result }, { status });
}

function rpcError(id: RpcId, code: number, message: string, status = 200): NextResponse {
  return NextResponse.json(
    { jsonrpc: JSONRPC, id, error: { code, message } },
    { status },
  );
}

function unauthorized(id: RpcId, message: string): NextResponse {
  const res = rpcError(id, -32001, message, 401);
  res.headers.set('WWW-Authenticate', 'Bearer');
  return res;
}

const CallParamsSchema = z.object({
  name: z.string().min(1).max(64),
  arguments: z.unknown().optional(),
});

/** MCP-shaped tool list for this token's scope. */
function mcpTools(token: AgentTokenRowLike): Array<{ name: string; description: string; inputSchema: unknown }> {
  const tools = toolDescriptors().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  if (token.scope === 'platform') {
    for (const t of platformToolDescriptors()) {
      tools.push({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: {} } });
    }
  }
  return tools;
}

function toMcpResult(outcome: RemoteToolOutcome): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    label: outcome.label,
    detail: outcome.detail,
    data: outcome.data,
    status: outcome.status,
  };
  if (outcome.confirmRequired) payload.confirmRequired = outcome.confirmRequired;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: outcome.status === 'error',
  };
}

export async function POST(req: Request): Promise<Response> {
  // Echoed by every response — including -32603 from the catch below.
  let rpcId: RpcId = null;
  try {
    // Auth first — the challenge must come before any body parsing.
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return unauthorized(null, 'Unauthorized — present `Authorization: Bearer nrae_…` (NURAE AgentToken).');
    }
    const token = await resolveAgentToken(req);
    if (!token) {
      return unauthorized(null, 'Unauthorized — missing, malformed, unknown or revoked AgentToken.');
    }

    let envelope: unknown;
    try {
      envelope = await req.json();
    } catch {
      return rpcError(null, -32700, 'Parse error — the request body is not valid JSON.', 400);
    }
    if (typeof envelope !== 'object' || envelope === null) {
      return rpcError(null, -32600, 'Invalid Request — expected a JSON-RPC 2.0 object.', 400);
    }
    const req0 = envelope as Record<string, unknown>;
    const id = (typeof req0.id === 'string' || typeof req0.id === 'number' ? req0.id : null) as RpcId;
    rpcId = id;
    const isNotification = !('id' in req0);
    if (req0.jsonrpc !== JSONRPC || typeof req0.method !== 'string') {
      return rpcError(id, -32600, 'Invalid Request — jsonrpc must be "2.0" and method must be a string.', 400);
    }
    const method = req0.method;

    // JSON-RPC notifications get no payload back.
    if (isNotification) {
      return new NextResponse(null, { status: 202 });
    }

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'nurae', version: NURAE_VERSION },
        });

      case 'notifications/initialized':
        return new NextResponse(null, { status: 202 });

      case 'tools/list':
        return rpcResult(id, { tools: mcpTools(token) });

      case 'tools/call': {
        const params = req0.params;
        const parsed = CallParamsSchema.safeParse(
          typeof params === 'object' && params !== null ? params : {},
        );
        if (!parsed.success) {
          return rpcError(id, -32602, 'Invalid params — expected { name: string, arguments?: unknown }.');
        }
        // Shared budget with /api/v1/tools/call: one token, one 60/min limit.
        const rl = rateLimit(`agent-api:call:${token.id}`, 60, 60_000);
        if (!rl.allowed) {
          return rpcError(id, -32000, `Rate limit exceeded — try again in ${rl.retryAfter}s.`, 429);
        }
        const outcome = await runRemoteToolCall(token, {
          tool: parsed.data.name,
          args: parsed.data.arguments,
          // Parity with /api/v1/tools/call: the caller's confirm flag rides
          // inside the tool arguments (tool schemas own a `confirm` field);
          // the human-approval proxy is the token's allowConsequential flag.
          confirm:
            typeof parsed.data.arguments === 'object' &&
            parsed.data.arguments !== null &&
            (parsed.data.arguments as Record<string, unknown>).confirm === true,
        }, 1);
        return rpcResult(id, toMcpResult(outcome));
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`);
    }
  } catch (err) {
    console.error(`[NURAE] mcp: ${err instanceof Error ? err.message : String(err)}`);
    return rpcError(rpcId, -32603, 'Internal error — the request failed on the server.');
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      error: 'POST only. This endpoint speaks JSON-RPC 2.0 (initialize, tools/list, tools/call) with `Authorization: Bearer nrae_…`. See GET /api/openapi.json.',
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
