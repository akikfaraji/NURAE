/**
 * NURAE — the shared core behind /api/v1/tools/call and the MCP tools/call.
 *
 * One code path for BOTH remote surfaces so token-level gating can never
 * drift between them:
 *
 *  1. Identity: the ToolContext is built from the AgentToken row
 *     (agentTokenContext) + a synthetic audit session id. The request body
 *     can never inject a userId.
 *  2. Defense in depth on consequential tools: a token WITHOUT
 *     allowConsequential gets `status: 'confirm'` and NOTHING executes —
 *     even with confirm:true in the body. (This is deliberately stronger
 *     than the model-level gate inside executeTool: the token flag decides
 *     whether the remote agent may perform consequential actions at all.)
 *     A token WITH allowConsequential still goes through executeTool's own
 *     confirm semantics (the call must carry confirm:true AND the tool runs
 *     with userConfirmed only when the human approved).
 *  3. Every execution writes the same sanitized audit rows as web agents.
 */

import { randomUUID } from 'node:crypto';
import { executeTool, getTool, type ToolContext } from './tools';
import { agentTokenContext, type AgentTokenRowLike } from '../auth/agent-tokens';

export interface RemoteToolCallInput {
  tool: string;
  args?: unknown;
  confirm?: boolean;
}

export interface RemoteToolOutcome {
  ok: boolean;
  status: 'ok' | 'error' | 'confirm';
  label: string;
  detail?: string;
  data?: unknown;
  /** Present iff status === 'confirm' — how the caller unblocks the action. */
  confirmRequired?: { reason: string; how: string };
}

function confirmOutcome(label: string, reason: string): RemoteToolOutcome {
  return {
    ok: false,
    status: 'confirm',
    label,
    detail: reason,
    confirmRequired: {
      reason,
      how: 'resend with confirm:true after the human approves',
    },
  };
}

/**
 * Validate, gate and execute one remote tool call. Never throws —
 * failures come back as structured outcomes.
 */
export async function runRemoteToolCall(
  token: AgentTokenRowLike,
  input: RemoteToolCallInput,
  seq = 1,
): Promise<RemoteToolOutcome> {
  const spec = getTool(input.tool);

  // Token-level gate: consequential actions are impossible without the
  // allowConsequential flag — regardless of any confirm in the body.
  if (spec?.consequential && !token.allowConsequential) {
    return confirmOutcome(
      `Waiting for approval to run "${input.tool}"`,
      `This token is not allowed to perform consequential actions (allowConsequential=false). ` +
        `Approve the action in the NURAE dashboard or mint a token with allowConsequential, then resend with confirm:true.`,
    );
  }

  const base = agentTokenContext(token);
  const ctx: ToolContext = {
    userId: base.userId ?? '',
    sessionId: `api-${randomUUID()}`,
    userConfirmed: input.confirm === true,
    platform: base.platform,
  };

  const record = await executeTool(ctx, input.tool, input.args ?? {}, seq);

  const outcome: RemoteToolOutcome = {
    // ok is true ONLY when the tool actually executed successfully —
    // 'confirm' means nothing ran yet, 'error' means it failed.
    ok: record.status === 'ok',
    status: record.status,
    label: record.label,
    detail: record.detail,
    data: record.data,
  };
  if (record.status === 'confirm') {
    outcome.confirmRequired = {
      reason: record.detail ?? record.label,
      how: 'resend with confirm:true after the human approves',
    };
  }
  return outcome;
}
