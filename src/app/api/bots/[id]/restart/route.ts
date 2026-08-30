/** NURAE — POST /api/bots/{id}/restart (auth-guarded, spec §18) */
import { performLifecycle } from '@/lib/nurae/api/lifecycle';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return performLifecycle(req, id, 'restart');
}
