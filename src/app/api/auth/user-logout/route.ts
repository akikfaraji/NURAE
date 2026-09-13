/** NURAE — customer logout: deletes the session row and clears the cookie. */

import { NextResponse } from 'next/server';
import { destroyUserSession } from '@/lib/nurae/auth/sessions';

export async function POST(req: Request): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  try {
    await destroyUserSession(req, res);
  } catch {
    /* cookie is cleared regardless */
  }
  return res;
}
