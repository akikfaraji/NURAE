/**
 * NURAE — in-memory rate limiter for public endpoints.
 *
 * Fixed-window counters keyed by (bucket, clientKey). Single-process scope:
 * sufficient for the self-hosted deployments NURAE targets (the whole
 * platform runs in one Node process). Resets on restart — acceptable for
 * abuse damping, not for billing-grade quotas.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Number of timed-out entries beyond which the map is swept. */
const SWEEP_THRESHOLD = 1024;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when blocked). */
  retryAfter: number;
  remaining: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > SWEEP_THRESHOLD) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000), remaining: 0 };
  }
  return { allowed: true, retryAfter: 0, remaining: limit - existing.count };
}

/**
 * Best-effort client identity for rate limiting (proxy-aware, hardened).
 *
 * Uses the RIGHTMOST entry of x-forwarded-for: standard proxies APPEND the
 * connecting client's address, so the last entry is the one the trusted edge
 * actually observed — a client cannot move it by sending extra entries.
 * (The previous leftmost behavior let an attacker rotate fresh identities by
 * forging the first hop.) Edge proxies that OVERWRITE the header (the
 * shipped Caddyfile) leave exactly one entry, which this also handles.
 * x-real-ip (set by platforms like Vercel) is the next best signal; without
 * any proxy header everything shares the 'local' bucket.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get('x-real-ip') ?? 'local';
}

/**
 * Per-ACCOUNT failure damping for password login (keyed by the lowercased
 * email, NOT by IP — an attacker rotating spoofed proxies must not get
 * unlimited guesses against one mailbox). Only failed attempts are counted;
 * a successful login is never blocked, so victims cannot be locked out.
 */
export function recordLoginFailure(email: string): RateLimitResult {
  return rateLimit(`login-fail:${email.trim().toLowerCase()}`, 10, 10 * 60 * 1000);
}
