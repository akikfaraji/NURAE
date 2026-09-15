/**
 * NURAE — growth-link resolution, shared by every built-in-bot path
 * (user one-click templates AND the official fleet seeding).
 *
 * Precedence: explicit env (NURAE_SITE_URL) wins, then the deployment's
 * public URL (NURAE_PUBLIC_URL), then — for request-time callers — the
 * request's own origin (x-forwarded aware). Community/channel shortcuts
 * are opt-in via env. Only absolute http(s) URLs qualify: bot link buttons
 * are validated by the behavior compiler, so a relative "fallback" would
 * be worse than none.
 */

import type { GrowthLinks } from './templates';

function trimUrl(v: string | undefined): string | undefined {
  const t = (v ?? '').trim();
  return /^https?:\/\//i.test(t) ? t : undefined;
}

/** Env-only resolution — returns null when no site URL is configured. */
export function growthLinksFromEnv(): GrowthLinks | null {
  const siteUrl = trimUrl(process.env.NURAE_SITE_URL) ?? trimUrl(process.env.NURAE_PUBLIC_URL);
  if (!siteUrl) return null;
  return {
    siteUrl,
    communityUrl: trimUrl(process.env.NURAE_COMMUNITY_URL),
    channelUrl: trimUrl(process.env.NURAE_CHANNEL_URL),
  };
}

/** Request-aware resolution — always yields a site URL (origin fallback). */
export function resolveGrowthLinks(req: Request): GrowthLinks {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const origin = `${proto}://${host}`;
  return {
    siteUrl: trimUrl(process.env.NURAE_SITE_URL) ?? trimUrl(process.env.NURAE_PUBLIC_URL) ?? origin,
    communityUrl: trimUrl(process.env.NURAE_COMMUNITY_URL),
    channelUrl: trimUrl(process.env.NURAE_CHANNEL_URL),
  };
}
