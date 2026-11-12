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
  // Don't advertise the framework (X-Powered-By: Next.js) — free recon for
  // attackers looking for known framework-level CVEs.
  poweredByHeader: false,
  // Security headers applied to every response (pages AND /api). CSP notes:
  //  - 'unsafe-inline' scripts: Next.js injects inline hydration/bootstrap
  //    scripts; a nonce-CSP requires fully dynamic rendering and breaks
  //    static pages. The XSS sink inventory is clean (react-markdown without
  //    rehype-raw, no user-data dangerouslySetInnerHTML), so this is the
  //    pragmatic hardening level today.
  //  - 'unsafe-eval': needed by Next dev (react-refresh); harmless to keep
  //    for prod parity of the header string.
  //  - fonts.googleapis/gstatic: Julius Sans One / Share Tech Mono / Jost
  //    (see src/app/layout.tsx preconnect + stylesheet).
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // Clickjacking: forbid third-party framing (SAMEORIGIN keeps future
          // first-party embeds — e.g. Telegram Mini Apps — possible).
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // MIME confusion: never sniff responses into executable types.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Referrer hygiene: cross-origin navigations leak only the origin.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Deny powerful platform APIs the product does not use.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()',
          },
          // HTTPS-only future visits once a deployment is https (no-op over http).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Isolate browsing context from cross-origin popups/documents.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
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
