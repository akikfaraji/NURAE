/**
 * NURAE — /api/admin/agent-tokens: the operator's PLATFORM-scope agent
 * tokens (ownerId null — these act on the whole server through the platform
 * tool tier). Admin-token guarded (same guard as the rest of the dashboard).
 * GET  → list platform tokens (metadata only)
 * POST → mint one { name, allowConsequential? } — raw key returned exactly once
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, guard, internalError, validationError } from '@/lib/nurae/api/base';
import { createAgentToken, toAgentTokenDTO } from '@/lib/nurae/auth/agent-tokens';

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  allowConsequential: z.boolean().default(false),
});

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const rows = await db.agentToken.findMany({
      where: { scope: 'platform', ownerId: null },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ tokens: rows.map(toAgentTokenDTO) });
  } catch (err) {
    return internalError(err, 'admin/agent-tokens.list');
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const { token, row } = await createAgentToken({
      name: parsed.data.name,
      scope: 'platform',
      ownerId: null,
      allowConsequential: parsed.data.allowConsequential,
    });
    return NextResponse.json({ token, tokenMeta: toAgentTokenDTO(row) }, { status: 201 });
  } catch (err) {
    return internalError(err, 'admin/agent-tokens.create');
  }
}
