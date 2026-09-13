/**
 * NURAE — persisted support chat history for the signed-in customer.
 * GET /api/support/history → { messages: [{ id, role, content, timestamp }] }
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { supportChatHistory } from '@/lib/nurae/auth/official-bot';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    const messages = await supportChatHistory(user.id, 50);
    return NextResponse.json({ messages });
  } catch (err) {
    return internalError(err, 'support/history');
  }
}
