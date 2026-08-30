/** NURAE — admin logout: clears the session cookie. */
import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/lib/nurae/api/base';

export async function POST(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.headers.append('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
