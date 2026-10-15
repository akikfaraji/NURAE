import type { NextConfig } from "next";

/**
 * NOTE (dev workflow): after `prisma db push` / `prisma generate` regenerates
 * the Prisma Client, a long-running `next dev` process keeps serving its
 * in-memory (stale) client until the server worker reloads. Touching this
 * config file makes Next.js dev restart itself cleanly — no manual kill.
 *
 * Split-deployment mode (used by the split E2E workflow):
 *
 *   Vercel serves the dashboard (this deployment) and PROXIES every /api/*
 *   request to the real backend (NURAE_BACKEND_URL), keeping the browser
 *   same-origin — no CORS, auth cookies keep working unchanged.
 *
 *   - Unset NURAE_BACKEND_URL (default): single-process NURAE, API routes
 *     serve requests locally. This is local dev and the GitHub Actions runner.
 *   - Set NURAE_BACKEND_URL (e.g. https://xyz.trycloudflare.com): API routes
 *     are shadowed by a beforeFiles rewrite, which takes precedence over
 *     filesystem routes (a plain-array "afterFiles" rewrite would NOT
 *     intercept /api/* route handlers — this must stay beforeFiles).
 */
async function rewrites() {
  const backend = process.env.NURAE_BACKEND_URL?.trim();
  if (!backend) return [];
  return {
    beforeFiles: [
      {
        source: "/api/:path*",
        destination: `${backend.replace(/\/+$/, "")}/api/:path*`,
      },
    ],
  };
}

const nextConfig: NextConfig = {
  output: "standalone",
  // NOTE: live data (db/, .env, uploads) would otherwise be COPIED into
  // .next/standalone by the file tracer — its include/exclude hooks do not
  // apply to static-page and instrumentation trace files, so the exclusion is
  // done deterministically in the `build` script instead (rm -rf after copy).
  // The production server (scripts/start-prod.mjs + src/lib/paths.ts) always
  // resolves data paths against the PROJECT root, never the build output.
  // Pin the Turbopack workspace root to THIS directory. Without this, Turbopack
  // infers the root from the nearest lockfile — if NURAE is cloned inside
  // another JS project (or a stray lockfile sits in a parent folder), the
  // standalone output layout breaks (server.js lands in the wrong tree) and a
  // "multiple lockfiles" warning is printed. Pinning is what Next.js recommends.
  turbopack: {
    root: __dirname,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Native/hard-to-bundle server packages stay external (required at runtime,
  // not inlined): libSQL engine binaries + the Prisma driver adapter, and
  // nodemailer (SMTP). Prisma's driver-adapter docs recommend exactly this.
  serverExternalPackages: [
    "@libsql/client",
    "@prisma/adapter-libsql",
    "libsql",
    "nodemailer",
  ],
  // Client-bundle safety net (webpack builds only — Turbopack ignores this
  // hook): if any Node-only module ever leaks into a client component's
  // import graph, fail the resolution instead of polyfilling Node builtins
  // with browser shims that blow up at runtime with cryptic errors.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        stream: false,
        crypto: false,
        fs: false,
        path: false,
        os: false,
        zlib: false,
        util: false,
        url: false,
        async_hooks: false,
        tls: false,
        net: false,
        buffer: false,
        dns: false,
        child_process: false,
        http: false,
        https: false,
        querystring: false,
      };
    }
    return config;
  },
  rewrites,
};

export default nextConfig;
