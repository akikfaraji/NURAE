import type { NextConfig } from "next";

/**
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
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  rewrites,
};

export default nextConfig;
