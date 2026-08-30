/**
 * NURAE — Projects collection.
 * GET  /api/projects — list projects with bot counts
 * POST /api/projects — create project { name, description? }
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, guard, internalError, validationError } from '@/lib/nurae/api/base';
import { createProjectSchema } from '@/lib/nurae/validation';

export async function GET(req: Request): Promise<Response> {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const projects = await db.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: { bots: { select: { id: true, status: true } } },
    });
    return NextResponse.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        botCount: p.bots.length,
        activeBots: p.bots.filter((b) => b.status === 'running').length,
      })),
    });
  } catch (err) {
    return internalError(err, 'projects.list');
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
      return apiError('Invalid JSON body', 400);
    }
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const project = await db.project.create({
      data: { name: parsed.data.name, description: parsed.data.description },
    });
    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
          botCount: 0,
          activeBots: 0,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return internalError(err, 'projects.create');
  }
}
