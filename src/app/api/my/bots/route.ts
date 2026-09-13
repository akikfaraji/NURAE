/**
 * NURAE — /api/my/bots: the signed-in customer's own bots.
 * GET  → list (ownership-filtered; archived hidden unless ?archived=1)
 * POST → create a draft { name, description?, telegramToken?, …, commands?, replies? }
 * Identity comes from the session cookie — never from a body field.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { createUserBot, listUserBots } from '@/lib/nurae/bots/user-bots';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    const bots = await listUserBots(user.id, { includeArchived });
    return NextResponse.json({ bots });
  } catch (err) {
    return internalError(err, 'my/bots.list');
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError('Invalid JSON body');
    }
    const result = await createUserBot(user.id, body);
    if (result.error || !result.bot) {
      return NextResponse.json(
        { error: result.error ?? 'Could not create the bot', fields: result.fields },
        { status: 422 },
      );
    }
    return NextResponse.json({ bot: result.bot }, { status: 201 });
  } catch (err) {
    return internalError(err, 'my/bots.create');
  }
}
