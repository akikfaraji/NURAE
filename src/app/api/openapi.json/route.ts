/**
 * NURAE — GET /api/openapi.json: the machine-readable contract for the
 * remote agent API (OpenAPI 3.1). Hand-written but honest: every path
 * documents the auth it actually requires and the shapes it actually
 * returns. Relative server URL — the document works from any origin.
 */

import { NextResponse } from 'next/server';
import { NURAE_NAME, NURAE_TAGLINE, NURAE_VERSION } from '@/lib/nurae/version';

const bearer = [{ bearerAuth: [] }];

const errorRes = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonRes = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

const body = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
});

export async function GET(): Promise<Response> {
  const doc = {
    openapi: '3.1.0',
    info: {
      title: `${NURAE_NAME} — Remote Agent API`,
      version: NURAE_VERSION,
      description:
        `${NURAE_TAGLINE}. This contract lets external AI agents (e.g. Claude) operate ` +
        `NURAE over Bearer AgentTokens: discover tools, call them with human-approval ` +
        `semantics, drive the Bot Builder agent, or speak MCP (JSON-RPC 2.0) on /api/mcp. ` +
        `Identity always comes from the token — never from a request body.`,
    },
    servers: [{ url: '' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'NURAE AgentToken: `Authorization: Bearer nrae_…`. Minted once in the NURAE ' +
            'dashboard (API keys card); only a SHA-256 hash is stored; revocation is instant.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        ToolCallRequest: {
          type: 'object',
          required: ['tool'],
          properties: {
            tool: { type: 'string', description: 'Tool name from GET /api/v1/tools (e.g. bots_list).' },
            args: {
              description: 'Tool arguments — validated against the tool JSON schema.',
              type: 'object',
              additionalProperties: true,
            },
            confirm: {
              type: 'boolean',
              default: false,
              description:
                'Human-approval flag for consequential tools. Ignored unless the token was minted with allowConsequential=true.',
            },
          },
        },
        ToolCallResponse: {
          type: 'object',
          required: ['ok', 'status', 'label'],
          properties: {
            ok: { type: 'boolean', description: 'false iff status is "error".' },
            status: { type: 'string', enum: ['ok', 'error', 'confirm'] },
            label: { type: 'string', description: 'Human-readable one-line result.' },
            detail: { type: 'string' },
            data: { description: 'Structured tool result (JSON).' },
            confirmRequired: {
              type: 'object',
              properties: {
                reason: { type: 'string' },
                how: { type: 'string', const: 'resend with confirm:true after the human approves' },
              },
            },
          },
        },
        AgentTurnRequest: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: 8000 },
            sessionId: { type: 'string', description: 'Continue this agent session; omit to continue/create the owner’s workspace.' },
            attachmentIds: { type: 'array', items: { type: 'string' }, maxItems: 5 },
          },
        },
        AgentTurnResponse: {
          type: 'object',
          required: ['sessionId', 'reply', 'steps', 'done'],
          properties: {
            sessionId: { type: 'string' },
            reply: { type: 'string' },
            steps: {
              type: 'array',
              description: 'Tool activity for this turn.',
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'integer' },
                  tool: { type: 'string' },
                  label: { type: 'string' },
                  status: { type: 'string', enum: ['ok', 'error', 'confirm'] },
                  detail: { type: 'string' },
                  data: {},
                },
              },
            },
            needsConfirm: { type: 'boolean' },
            done: { type: 'boolean' },
            draftBotId: { type: ['string', 'null'] },
            error: { type: 'string' },
          },
        },
        JsonRpcRequest: {
          type: 'object',
          required: ['jsonrpc', 'method'],
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { type: ['string', 'number', 'null'] },
            method: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          summary: 'Platform health + version (public).',
          operationId: 'getHealth',
          security: [],
          responses: {
            '200': jsonRes('Health snapshot', {
              type: 'object',
              properties: {
                status: { type: 'string' },
                version: { type: 'string' },
                name: { type: 'string' },
                vendor: { type: 'string' },
              },
            }),
          },
        },
      },
      '/api/agents/tools': {
        get: {
          summary: 'Public tool manifest (JSON-schema descriptors + skills).',
          operationId: 'getPublicManifest',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': jsonRes('Registry envelope', {
              type: 'object',
              properties: {
                registry: { type: 'string', const: 'nurae.tools' },
                version: { type: 'integer' },
                tools: { type: 'array', items: { type: 'object' } },
                skills: { type: 'array', items: { type: 'object' } },
              },
            }),
          },
        },
      },
      '/api/v1/me': {
        get: {
          summary: 'Who is this AgentToken?',
          operationId: 'getMe',
          security: bearer,
          responses: {
            '200': jsonRes('Token identity', {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                prefix: { type: 'string' },
                scope: { type: 'string', enum: ['user', 'platform'] },
                allowConsequential: { type: 'boolean' },
                owner: {
                  type: ['object', 'null'],
                  properties: { email: { type: 'string' } },
                },
                createdAt: { type: 'string', format: 'date-time' },
              },
            }),
            '401': errorRes('Missing/invalid/revoked token'),
          },
        },
      },
      '/api/v1/tools': {
        get: {
          summary: 'Tool registry + skills for THIS token (platform scope adds the operator tier).',
          operationId: 'getV1Tools',
          security: bearer,
          responses: {
            '200': jsonRes('Registry envelope', {
              type: 'object',
              properties: {
                registry: { type: 'string', const: 'nurae.tools' },
                version: { type: 'integer' },
                tools: { type: 'array', items: { type: 'object' } },
                skills: { type: 'array', items: { type: 'object' } },
                platformTools: { type: 'array', items: { type: 'object' } },
                operatorSkills: { type: 'array', items: { type: 'object' } },
              },
            }),
            '401': errorRes('Missing/invalid/revoked token'),
          },
        },
      },
      '/api/v1/tools/call': {
        post: {
          summary: 'Execute one tool call.',
          description:
            'Always HTTP 200 — tool failures travel in the body (status "error"). status ' +
            '"confirm" means the action waits for human approval: consequential tools never ' +
            'execute unless the token has allowConsequential AND the call carries confirm:true.',
          operationId: 'callTool',
          security: bearer,
          requestBody: body({ $ref: '#/components/schemas/ToolCallRequest' }),
          responses: {
            '200': jsonRes('Tool outcome', { $ref: '#/components/schemas/ToolCallResponse' }),
            '400': errorRes('Invalid JSON body'),
            '401': errorRes('Missing/invalid/revoked token'),
            '422': errorRes('Envelope validation failed'),
            '429': errorRes('Rate limit exceeded (60 calls/min per token)'),
          },
        },
      },
      '/api/v1/agent/turn': {
        post: {
          summary: 'One full Bot Builder agent turn.',
          description:
            'User-scope tokens only. Consequential approvals stay in the web UI — userConfirmed is false here.',
          operationId: 'agentTurn',
          security: bearer,
          requestBody: body({ $ref: '#/components/schemas/AgentTurnRequest' }),
          responses: {
            '200': jsonRes('Turn result', { $ref: '#/components/schemas/AgentTurnResponse' }),
            '400': errorRes('Agent could not run (e.g. AI layer unconfigured)'),
            '401': errorRes('Missing/invalid/revoked token or owner gone'),
            '403': errorRes('Platform-scope token, or owner email unverified'),
            '404': errorRes('Unknown sessionId / agent session'),
            '422': errorRes('Envelope validation failed'),
            '429': errorRes('Rate limit exceeded (20 turns/min per token)'),
          },
        },
      },
      '/api/mcp': {
        post: {
          summary: 'MCP connector surface (JSON-RPC 2.0).',
          description:
            'Methods: initialize, notifications/initialized (202), tools/list, tools/call. ' +
            'Errors: -32700 parse, -32600 envelope, -32601 unknown method, -32602 bad params, -32603 internal.',
          operationId: 'mcp',
          security: bearer,
          requestBody: body({ $ref: '#/components/schemas/JsonRpcRequest' }),
          responses: {
            '200': jsonRes('JSON-RPC response', {
              type: 'object',
              properties: {
                jsonrpc: { type: 'string', const: '2.0' },
                id: { type: ['string', 'number', 'null'] },
                result: { type: 'object', additionalProperties: true },
                error: {
                  type: 'object',
                  properties: { code: { type: 'integer' }, message: { type: 'string' } },
                },
              },
            }),
            '202': { description: 'Notification accepted (empty body)' },
            '401': errorRes('No/invalid Authorization header (WWW-Authenticate: Bearer)'),
            '405': errorRes('GET is not supported'),
            '429': errorRes('Rate limit exceeded (tools/call shares the 60/min budget)'),
          },
        },
        get: {
          summary: 'Capability hint — POST only.',
          operationId: 'mcpHint',
          security: [],
          responses: { '405': errorRes('POST JSON-RPC 2.0 instead') },
        },
      },
    },
  };

  return NextResponse.json(doc, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
