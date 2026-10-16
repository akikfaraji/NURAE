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
 * Trust model for the identity below — see NURAE_TRUSTED_PROXY in .env.example.
 *
 * x-forwarded-for is CLIENT-SUPPLIED data: only the edge in front of this
 * process decides which entry may be believed. Two shipped shapes:
 *
 *   - NURAE_TRUSTED_PROXY=1 → the edge OVERWRITES the header (the shipped
 *     Caddyfile does exactly that: `header_up X-Forwarded-For {remote_host}`),
 *     so the LEFTMOST entry is the address the edge actually observed.
 *   - unset (default) → the historical proxy-APPEND assumption: the proxy
 *     keeps what the client sent and appends, so the RIGHTMOST entry is the
 *     one the trusted edge observed and an attacker cannot rotate buckets by
 *     forging the first hop. A client reaching this process DIRECTLY (no edge
 *     at all) can still forge the whole header — which is precisely the
 *     deployment NURAE_TRUSTED_PROXY=1 does not describe. Never expose the
 *     process to the internet without an overwriting edge; when you have one,
 *     set the flag so the leftmost (edge-written) entry is the key.
 */
export function trustedProxy(): boolean {
  return process.env.NURAE_TRUSTED_PROXY === '1';
}

/**
 * Best-effort client identity for rate limiting (proxy-aware, trust-model-aware).
 *
 * The leftmost/rightmost choice follows the edge shape documented above; the
 * result is always a per-client key (never a shared "all clients" bucket, which
 * would turn one attacker into a denial of service for everybody). x-real-ip
 * (set by platforms like Vercel) is the next best signal; with no proxy header
 * at all everything shares the 'local' bucket.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return trustedProxy() ? parts[0] : parts[parts.length - 1];
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
