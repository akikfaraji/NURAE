/**
 * NURAE — GET /api/agents/tools: the tool registry in MCP-compatible form.
 * Every NURAE capability an agent can use, with its JSON schema, kind
 * (read/write) and whether it is consequential (needs user approval).
 * This is a real discovery surface — not a buzzword: external MCP clients
 * can enumerate NURAE capabilities from here.
 */

import { NextResponse } from 'next/server';
import { internalError } from '@/lib/nurae/api/base';
import { toolDescriptors } from '@/lib/nurae/agents/tools';

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({
      registry: 'nurae.tools',
      version: 1,
      tools: toolDescriptors(),
    });
  } catch (err) {
    return internalError(err, 'agents.tools');
  }
}
