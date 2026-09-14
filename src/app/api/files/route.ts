/**
 * NURAE — POST /api/files: upload a file (multipart/form-data, field "file").
 * Accepts PDF, Markdown, TXT, CSV, DOCX, images, JSON (see files.ts for the
 * full matrix). Text is extracted server-side; ownership is session-derived.
 * GET → list the caller's files (newest first, capped).
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { MAX_UPLOAD_BYTES, saveUserFile } from '@/lib/nurae/files';
import { chargeFeature } from '@/lib/nurae/billing/wallet';
import { formatUsd } from '@/lib/nurae/billing/catalog';

const ALLOWED_EXTENSIONS = /\.(pdf|md|markdown|txt|csv|docx|json|log|png|jpe?g|gif|webp|svg)$/i;

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError('Expected multipart/form-data with a "file" field.', 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('Missing "file" field.', 422);
    if (file.size === 0) return apiError('The file is empty.', 422);
    if (file.size > MAX_UPLOAD_BYTES) {
      return apiError(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`, 413);
    }
    const name = file.name || 'upload';
    if (!ALLOWED_EXTENSIONS.test(name)) {
      return apiError('Unsupported file type. Allowed: PDF, Markdown, TXT, CSV, DOCX, JSON, images.', 415);
    }

    const sessionIdRaw = form.get('sessionId');
    let sessionId: string | null = null;
    if (typeof sessionIdRaw === 'string' && sessionIdRaw.trim()) {
      // The session must belong to the caller (no cross-session planting).
      const session = await db.chatSession.findFirst({
        where: { id: sessionIdRaw.trim(), userId: user.id },
        select: { id: true },
      });
      sessionId = session?.id ?? null;
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // Pay-as-you-use: storage is billed per MB (rounded up); free tier covers
    // the first 20 MB/day, the trial and premium weeks cover everything.
    const units = Math.max(1, Math.ceil(bytes.length / (1024 * 1024)));
    const charge = await chargeFeature(user.id, 'file_upload_mb', { units }).catch(() => null);
    if (charge?.outcome === 'skipped') {
      return apiError(
        `Out of credits — this upload needs ${units} MB (${formatUsd(charge.chargedMicros)}). Top up in Billing first.`,
        402,
      );
    }

    const stored = await saveUserFile({
      userId: user.id,
      sessionId,
      name: name,
      mime: file.type || 'application/octet-stream',
      bytes,
    });
    return NextResponse.json({ file: stored }, { status: 201 });
  } catch (err) {
    return internalError(err, 'files.upload');
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const rows = await db.userFile.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        mime: true,
        size: true,
        kind: true,
        status: true,
        sessionId: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ files: rows });
  } catch (err) {
    return internalError(err, 'files.list');
  }
}
