/**
 * NURAE — single project.
 * GET    /api/projects/{id} — project detail (with bots)
 * PUT    /api/projects/{id} — rename / archive (extra, beyond spec minimum)
 * DELETE /api/projects/{id} — delete project + cascade bots (extra)
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, toBotDTO, validationError } from '@/lib/nurae/api/base';
import { updateProjectSchema } from '@/lib/nurae/validation';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const project = await db.project.findUnique({
      where: { id },
      include: { bots: { orderBy: { createdAt: 'desc' } } },
    });
    if (!project) return apiError('Project not found', 404);
    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
      bots: project.bots.map(toBotDTO),
    });
  } catch (err) {
    return internalError(err, 'projects.detail');
  }
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const existing = await db.project.findUnique({ where: { id } });
    if (!existing) return apiError('Project not found', 404);

    const project = await db.project.update({ where: { id }, data: parsed.data });
    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    return internalError(err, 'projects.update');
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const existing = await db.project.findUnique({
      where: { id },
      include: { bots: { select: { id: true, status: true } } },
    });
    if (!existing) return apiError('Project not found', 404);

    // Best-effort stop of running bots before deleting rows (cascade cleans DB).
    await Promise.allSettled(
      existing.bots
        .filter((b) => b.status === 'running' || b.status === 'starting')
        .map((b) => fetchStopBot(b.id)),
    );
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError(err, 'projects.delete');
  }
}

async function fetchStopBot(botId: string): Promise<void> {
  try {
    const { runtimeClient } = await import('@/lib/nurae/api/runtime-client');
    await runtimeClient.stop(botId);
  } catch {
    /* runtime down — cascade delete still proceeds */
  }
}
