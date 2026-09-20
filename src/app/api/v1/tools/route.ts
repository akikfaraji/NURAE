/**
 * NURAE — GET /api/v1/tools: the capability discovery surface for external
 * AI agents. Same registry as GET /api/agents/tools (user tier + skills);
 * platform-scope tokens ALSO get the operator tier (platformTools +
 * operatorSkills). Requires a Bearer AgentToken — the manifest itself stays
 * public at /api/agents/tools, this one answers "what can THIS token do".
 */

import { NextResponse } from 'next/server';
import { requireAgentToken } from '@/lib/nurae/api/agent-auth';
import { internalError } from '@/lib/nurae/api/base';
import { toolDescriptors } from '@/lib/nurae/agents/tools';
import { platformToolDescriptors } from '@/lib/nurae/agents/platform-tools';
import { skillManifest } from '@/lib/nurae/agents/skills';

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await requireAgentToken(req);
    if (!auth.ok) return auth.res;
    const payload: Record<string, unknown> = {
      registry: 'nurae.tools',
      version: 2,
      tools: toolDescriptors(),
      skills: skillManifest('builder'),
    };
    if (auth.token.scope === 'platform') {
      payload.platformTools = platformToolDescriptors();
      payload.operatorSkills = skillManifest('operator');
    }
    return NextResponse.json(payload);
  } catch (err) {
    return internalError(err, 'v1/tools');
  }
}
