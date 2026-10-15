/**
 * NURAE — Next.js instrumentation hook (runs once per server process).
 *
 * Thin delegator: the actual boot body lives in src/instrumentation-node.ts.
 * This file is compiled for BOTH the Node and Edge runtime targets in dev,
 * so it must contain no static Node-only imports — the runtime gate below
 * plus a dynamic import keeps the Edge bundle free of nodemailer / Prisma /
 * fs (any static Node import trips Turbopack's "not supported in the Edge
 * Runtime" warning on every request).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNode } = await import('./instrumentation-node');
  await registerNode();
}
