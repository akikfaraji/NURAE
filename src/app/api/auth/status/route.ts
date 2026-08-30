/** NURAE — auth status for the dashboard: { authRequired, authenticated }. */
import { NextResponse } from 'next/server';
import { authEnabled, guard } from '@/lib/nurae/api/base';

export async function GET(req: Request): Promise<Response> {
  const required = authEnabled();
  const denied = required ? guard(req) : null;
  return NextResponse.json({
    authRequired: required,
    authenticated: required ? !denied : true,
  });
}
