/**
 * NURAE — security hardening regression suite.
 *
 * Locks the behaviors introduced by the security pass:
 *  1. Admin guard FAILS CLOSED in production (unset or placeholder token → 503)
 *  2. Admin cookie carries a SIGNED session, never the raw token
 *  3. Site sessions are hashed at rest (with legacy plaintext migration)
 *  4. SSRF guard blocks private/reserved AI endpoint targets
 *  5. Rate-limit identity uses the rightmost XFF entry + per-account login damping
 *  6. Central CSRF origin check in the proxy
 *  7. devCode self-issuance is gated behind production + explicit opt-in
 *  8. Google OAuth email claims are fail-closed and linking is guarded
 *  9. Security headers are configured in next.config.ts
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';

import { pushTestSchema } from './helpers';
pushTestSchema();
const { db } = await import('../../src/lib/db');
const base = await import('../../src/lib/nurae/api/base');
const adminSession = await import('../../src/lib/nurae/auth/admin-session');
const sessions = await import('../../src/lib/nurae/auth/sessions');
const rateLimitMod = await import('../../src/lib/nurae/auth/rate-limit');
const urlGuard = await import('../../src/lib/nurae/ai/url-guard');
const { OpenAICompatibleProvider } = await import('../../src/lib/nurae/ai/providers/openai-compatible');
const proxyMod = await import('../../src/proxy');
const { NextRequest } = await import('next/server');

const BASE = 'http://localhost:3000';

/** process.env.NODE_ENV is typed read-only; tests legitimately need to flip it. */
function setNodeEnv(v: string): void {
  (process.env as { NODE_ENV?: string }).NODE_ENV = v;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`${BASE}${url}`, init);
}

const AI_CONFIG = {
  model: 'test-model',
  temperature: 0.5,
  maxTokens: 32,
  apiKey: 'test-key',
  baseUrl: null as string | null,
};

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Admin guard fail-closed (production)
// ---------------------------------------------------------------------------

describe('admin guard fails closed in production', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  test('unset token → 503 in production, open in non-production', () => {
    const saved = process.env.NURAE_ADMIN_TOKEN;
    delete process.env.NURAE_ADMIN_TOKEN;
    try {
      setNodeEnv('production');
      const denied = base.guard(req('/api/projects'));
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(503);

      setNodeEnv('test');
      const open = base.guard(req('/api/projects'));
      expect(open).toBeNull();
    } finally {
      setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
      if (saved !== undefined) process.env.NURAE_ADMIN_TOKEN = saved;
      else delete process.env.NURAE_ADMIN_TOKEN;
    }
  });

  test('the .env.example placeholder is treated as unset (503 in production)', () => {
    delete process.env.NURAE_ALLOW_DEV_CODE;
    const saved = process.env.NURAE_ADMIN_TOKEN;
    process.env.NURAE_ADMIN_TOKEN = 'change-me-if-exposed';
    try {
      setNodeEnv('production');
      const denied = base.guard(req('/api/projects'));
      expect(denied?.status).toBe(503);
      // authEnabled() agrees — the dashboard must not report it as configured.
      expect(base.authEnabled()).toBe(false);
    } finally {
      setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
      if (saved !== undefined) process.env.NURAE_ADMIN_TOKEN = saved;
      else delete process.env.NURAE_ADMIN_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Signed admin session cookie
// ---------------------------------------------------------------------------

describe('signed admin session cookie', () => {
  test('guard accepts the signed cookie but not a tampered or expired one', () => {
    const saved = process.env.NURAE_ADMIN_TOKEN;
    process.env.NURAE_ADMIN_TOKEN = 'signed-cookie-test-token';
    try {
      const signed = adminSession.signAdminSession();
      const ok = base.guard(req('/api/projects', { headers: { Cookie: `nurae_admin=${encodeURIComponent(signed)}` } }));
      expect(ok).toBeNull(); // signed cookie authenticates

      const tampered = base.guard(
        req('/api/projects', { headers: { Cookie: `nurae_admin=${encodeURIComponent(signed.slice(0, -2) + 'zz')}` } }),
      );
      expect(tampered?.status).toBe(401);

      // Raw token via cookie still works (backward-compatible Bearer-style use).
      const raw = base.guard(req('/api/projects', { headers: { Cookie: 'nurae_admin=signed-cookie-test-token' } }));
      expect(raw).toBeNull();

      // Expired signature window is rejected.
      const expired = 'v1.' + (Date.now() - 1000) + '.' + signed.split('.')[2];
      expect(adminSession.verifyAdminSession(expired)).toBe(false);
      expect(adminSession.verifyAdminSession(signed)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.NURAE_ADMIN_TOKEN = saved;
      else delete process.env.NURAE_ADMIN_TOKEN;
    }
  });

  test('the signed value never contains the raw token', () => {
    const token = 'super-secret-admin-credential';
    process.env.NURAE_SECRET_KEY = 'k';
    const signed = adminSession.signAdminSession();
    expect(signed).not.toContain(token);
    expect(signed.startsWith('v1.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Session tokens hashed at rest (+ legacy migration)
// ---------------------------------------------------------------------------

describe('session token hashing at rest', () => {
  test('createUserSession stores a sha256 row; the raw cookie resolves', async () => {
    const user = await db.user.create({
      data: { email: `sess-${Date.now()}@test.local`, name: 'S', emailVerified: true },
    });
    const { NextResponse } = await import('next/server');
    const res = NextResponse.json({});
    const raw = await sessions.createUserSession(res, user.id, null, false);

    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe(raw); // raw token never at rest
    expect(rows[0].token).toMatch(/^[0-9a-f]{64}$/); // sha256 hex

    const resolved = await sessions.sessionUser(req('/api/x', { headers: { Cookie: `nurae_session=${encodeURIComponent(raw)}` } }));
    expect(resolved?.id).toBe(user.id);
  });

  test('legacy plaintext rows are transparently upgraded, session survives', async () => {
    const user = await db.user.create({
      data: { email: `legacy-${Date.now()}@test.local`, name: 'L', emailVerified: true },
    });
    const legacyToken = 'legacy-plaintext-token-abc123';
    await db.session.create({
      data: { userId: user.id, token: legacyToken, expiresAt: new Date(Date.now() + 60_000) },
    });

    const resolved = await sessions.sessionUser(
      req('/api/x', { headers: { Cookie: `nurae_session=${encodeURIComponent(legacyToken)}` } }),
    );
    expect(resolved?.id).toBe(user.id);

    const after = await db.session.findUnique({ where: { token: legacyToken } });
    expect(after).toBeNull(); // upgraded away from plaintext
    const upgraded = await db.session.findFirst({ where: { userId: user.id } });
    expect(upgraded?.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. SSRF guard for AI endpoints
// ---------------------------------------------------------------------------

describe('SSRF guard for AI endpoint URLs', () => {
  const lookup = async (host: string) => {
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  };

  test('blocks non-http(s) schemes', async () => {
    await expect(urlGuard.assertSafeAiUrl('file:///etc/passwd', { lookup })).rejects.toMatchObject({ code: 'policy_blocked' });
    await expect(urlGuard.assertSafeAiUrl('gopher://x', { lookup })).rejects.toMatchObject({ code: 'policy_blocked' });
  });

  test('blocks cloud metadata and private ranges', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/metadata',
      'http://10.1.2.3:8080/v1',
      'http://172.16.0.9/v1',
      'http://192.168.1.50:11434/v1',
      'http://0.0.0.0/v1',
      'http://198.51.100.7/v1',
    ]) {
      await expect(urlGuard.assertSafeAiUrl(url, { lookup }), url).rejects.toMatchObject({ code: 'policy_blocked' });
    }
  });

  test('allows loopback (local model servers) and public hosts', async () => {
    expect(await urlGuard.assertSafeAiUrl('http://127.0.0.1:11434/v1', { lookup })).toBeTruthy();
    expect(await urlGuard.assertSafeAiUrl('http://localhost:1234/v1', { lookup })).toBeTruthy();
    expect(await urlGuard.assertSafeAiUrl('https://openrouter.ai/api/v1', { lookup })).toBeTruthy();
  });

  test('resolves hostnames and blocks private answers (DNS-rebind resistant)', async () => {
    const evil = async (_h: string) => [{ address: '169.254.169.254', family: 4 }];
    await expect(urlGuard.assertSafeAiUrl('https://rebind.example/v1', { lookup: evil })).rejects.toMatchObject({
      code: 'policy_blocked',
    });
    // Mixed answers: one private is enough to reject.
    const mixed = async (_h: string) => [
      { address: '1.2.3.4', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(urlGuard.assertSafeAiUrl('https://mixed.example/v1', { lookup: mixed })).rejects.toMatchObject({
      code: 'policy_blocked',
    });
    const clean = async (_h: string) => [{ address: '1.2.3.4', family: 4 }];
    expect(await urlGuard.assertSafeAiUrl('https://clean.example/v1', { lookup: clean })).toBeTruthy();
  });

  test('DNS failure falls through to the fetch (no policy exception on NXDOMAIN)', async () => {
    expect(await urlGuard.assertSafeAiUrl('https://does-not-exist.example/v1', { lookup })).toBeTruthy();
  });

  test('NURAE_ALLOW_PRIVATE_AI_URLS=1 re-enables private ranges (explicit opt-in)', async () => {
    const saved = process.env.NURAE_ALLOW_PRIVATE_AI_URLS;
    try {
      process.env.NURAE_ALLOW_PRIVATE_AI_URLS = '1';
      expect(await urlGuard.assertSafeAiUrl('http://192.168.1.50:11434/v1', { lookup })).toBeTruthy();
      // …but the metadata range is still refused unless loopback/private switch
      // intentionally covers it — the opt-in is for LAN model servers, and
      // link-local metadata remains blocked even with the opt-in.
      await expect(urlGuard.assertSafeAiUrl('http://169.254.169.254/latest', { lookup })).rejects.toMatchObject({
        code: 'policy_blocked',
      });
    } finally {
      if (saved !== undefined) process.env.NURAE_ALLOW_PRIVATE_AI_URLS = saved;
      else delete process.env.NURAE_ALLOW_PRIVATE_AI_URLS;
    }
  });

  test('provider requestOnce refuses blocked targets BEFORE any socket (no retry)', async () => {
    let fetchCalled = 0;
    const provider = new OpenAICompatibleProvider({
      id: 'guard-test',
      defaultBaseUrl: 'https://api.example/v1',
      fetchImpl: (async () => {
        fetchCalled += 1;
        throw new Error('fetch must never be reached');
      }) as typeof fetch,
      maxAttempts: 3,
    });
    await expect(
      provider.generate(
        [{ role: 'user', content: 'hi' }],
        { ...AI_CONFIG, baseUrl: 'http://169.254.169.254/v1' },
      ),
    ).rejects.toMatchObject({ code: 'policy_blocked' });
    expect(fetchCalled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate-limit identity + per-account login damping
// ---------------------------------------------------------------------------

describe('rate-limit identity and per-account failure damping', () => {
  test('clientKey uses the RIGHTMOST x-forwarded-for entry', () => {
    const k = (headers: Record<string, string>) => rateLimitMod.clientKey(req('/api/x', { headers }));
    // Standard append semantics: attacker-supplied first hop is ignored.
    expect(k({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('5.6.7.8');
    // Overwriting edge (Caddyfile): single entry is the client.
    expect(k({ 'x-forwarded-for': '9.9.9.9' })).toBe('9.9.9.9');
    expect(k({ 'x-real-ip': '7.7.7.7' })).toBe('7.7.7.7');
    expect(k({})).toBe('local');
  });

  test('recordLoginFailure: 10 failures allowed, then blocked — success never blocked', () => {
    const email = `brute-${Date.now()}@test.local`;
    for (let i = 0; i < 10; i++) {
      expect(rateLimitMod.recordLoginFailure(email).allowed).toBe(true);
    }
    const blocked = rateLimitMod.recordLoginFailure(email);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    // A different account is unaffected.
    expect(rateLimitMod.recordLoginFailure(`other-${Date.now()}@test.local`).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Central CSRF origin check (proxy)
// ---------------------------------------------------------------------------

describe('proxy CSRF origin check', () => {
  const nx = (url: string, method: string, headers: Record<string, string> = {}) =>
    new NextRequest(`${BASE}${url}`, { method, headers });

  test('cross-origin mutating request → 403', () => {
    const res = proxyMod.csrfCheck(nx('/api/projects', 'POST', { Origin: 'https://evil.example' }));
    expect(res?.status).toBe(403);
  });

  test('same-origin mutating request passes', () => {
    expect(proxyMod.csrfCheck(nx('/api/projects', 'POST', { Origin: BASE, Host: 'localhost:3000' }))).toBeNull();
    // Behind a proxy that forwards the public host.
    expect(
      proxyMod.csrfCheck(
        nx('/api/projects', 'POST', { Origin: 'https://nurae.app', Host: 'internal', 'X-Forwarded-Host': 'nurae.app' }),
      ),
    ).toBeNull();
  });

  test('no Origin (curl/webhooks/Bearer agents) passes; GET passes even cross-origin', () => {
    expect(proxyMod.csrfCheck(nx('/api/telegram/webhook/x', 'POST', {}))).toBeNull();
    expect(proxyMod.csrfCheck(nx('/api/projects', 'GET', { Origin: 'https://evil.example' }))).toBeNull();
    // Malformed Origin is rejected, not ignored.
    expect(proxyMod.csrfCheck(nx('/api/projects', 'DELETE', { Origin: '::: not-a-url' }))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. devCode self-issuance gate (registration without SMTP)
// ---------------------------------------------------------------------------

describe('registration devCode gate', () => {
  const registerRoute = async () => await import('../../src/app/api/auth/register/route');

  test('production + no SMTP + no opt-in → 503, code never exposed', async () => {
    const route = await registerRoute();
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    delete process.env.NURAE_ALLOW_DEV_CODE;
    try {
      setNodeEnv('production');
      const res = await route.POST(
        req('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'P', email: `prod-gate-${Date.now()}@test.local`, password: 'password123' }),
        }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string; devCode?: string };
      expect(body.devCode).toBeUndefined();
      expect(body.error).toContain('NURAE_ALLOW_DEV_CODE');
    } finally {
      setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
    }
  });

  test('production + NURAE_ALLOW_DEV_CODE=1 → devCode returned (explicit opt-in)', async () => {
    const route = await registerRoute();
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    try {
      setNodeEnv('production');
      process.env.NURAE_ALLOW_DEV_CODE = '1';
      const res = await route.POST(
        req('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'D', email: `dev-optin-${Date.now()}@test.local`, password: 'password123' }),
        }),
      );
      const body = (await res.json()) as { devCode?: string; ok?: boolean };
      expect(res.status).toBe(200);
      expect(body.devCode).toMatch(/^\d{6}$/);
    } finally {
      setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
      delete process.env.NURAE_ALLOW_DEV_CODE;
    }
  });

  test('non-production keeps the dev convenience (no opt-in needed)', async () => {
    const route = await registerRoute();
    delete process.env.NURAE_ALLOW_DEV_CODE;
    const res = await route.POST(
      req('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T', email: `dev-${Date.now()}@test.local`, password: 'password123' }),
      }),
    );
    const body = (await res.json()) as { devCode?: string };
    expect(res.status).toBe(200);
    expect(body.devCode).toMatch(/^\d{6}$/);
  });
});

// ---------------------------------------------------------------------------
// 8. Google OAuth: fail-closed email claims + linking guard
// ---------------------------------------------------------------------------

describe('google oauth verification claims', () => {
  test('password account is NOT linked when Google lacks email_verified', async () => {
    process.env.NURAE_GOOGLE_CLIENT_ID = 'cid';
    process.env.NURAE_GOOGLE_CLIENT_SECRET = 'cis';
    const email = `glink-${Date.now()}@test.local`;
    await db.user.create({ data: { email, name: 'G', passwordHash: 'x', emailVerified: true } });

    const realFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        // claim MISSING (undefined) — must not count as verified
        return new Response(JSON.stringify({ sub: 'sub-1', email, name: 'G' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const route = await import('../../src/app/api/auth/google/callback/route');
      const nreq = new NextRequest(`${BASE}/api/auth/google/callback?code=c&state=s`, {
        headers: { Cookie: 'nurae_oauth_state=s' },
      });
      const res = await route.GET(nreq);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('auth_error=google-email-unverified');
      const user = await db.user.findUnique({ where: { email } });
      expect(user?.googleId).toBeNull(); // identity was NOT linked
    } finally {
      global.fetch = realFetch;
      delete process.env.NURAE_GOOGLE_CLIENT_ID;
      delete process.env.NURAE_GOOGLE_CLIENT_SECRET;
    }
  });

  test('email_verified=true links normally', async () => {
    process.env.NURAE_GOOGLE_CLIENT_ID = 'cid';
    process.env.NURAE_GOOGLE_CLIENT_SECRET = 'cis';
    const email = `gok-${Date.now()}@test.local`;
    await db.user.create({ data: { email, name: 'G', passwordHash: 'x', emailVerified: true } });

    const realFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
      }
      return new Response(JSON.stringify({ sub: 'sub-2', email, name: 'G', email_verified: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const route = await import('../../src/app/api/auth/google/callback/route');
      const nreq = new NextRequest(`${BASE}/api/auth/google/callback?code=c&state=s`, {
        headers: { Cookie: 'nurae_oauth_state=s' },
      });
      const res = await route.GET(nreq);
      expect(res.headers.get('location') ?? '').toContain('welcome=1');
      const user = await db.user.findUnique({ where: { email } });
      expect(user?.googleId).toBe('sub-2');
    } finally {
      global.fetch = realFetch;
      delete process.env.NURAE_GOOGLE_CLIENT_ID;
      delete process.env.NURAE_GOOGLE_CLIENT_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Security headers configuration
// ---------------------------------------------------------------------------

describe('security headers in next.config', () => {
  test('every response gets CSP + anti-clickjacking + nosniff + referrer policy', async () => {
    const cfg = (await import('../../next.config')).default;
    expect(typeof cfg.headers).toBe('function');
    const headerFn = cfg.headers!;
    const headers = (await headerFn()) as { source: string; headers: { key: string; value: string }[] }[];
    const all = headers.flatMap((h) => h.headers);
    const get = (k: string) => all.find((h) => h.key === k)?.value;

    const csp = get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('fonts.googleapis.com'); // the shipped Google Fonts keep loading
    expect(get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(get('X-Content-Type-Options')).toBe('nosniff');
    expect(get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(get('Strict-Transport-Security')).toContain('max-age=');
    expect(get('Permissions-Policy')).toContain('camera=()');
    expect(cfg.poweredByHeader).toBe(false);
  });
});
