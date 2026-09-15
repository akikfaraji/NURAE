/**
 * NURAE — platform layer tests (Task 13): customer accounts, email
 * verification, user sessions, the official NURAE CS bot (seeding + web
 * chat), site settings and the customers directory.
 *
 * Route handlers are imported directly and invoked with Request objects
 * (same pattern as api.test.ts). AI + Telegram are stubbed at the fetch
 * level by telegram-stub.ts, so the support chat runs fully offline.
 */

import { describe, expect, test, afterAll, vi } from 'vitest';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { ensureOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const { NextRequest } = await import('next/server');

const registerRoute = await import('../../src/app/api/auth/register/route');
const verifyRoute = await import('../../src/app/api/auth/verify/route');
const userLoginRoute = await import('../../src/app/api/auth/user-login/route');
const userLogoutRoute = await import('../../src/app/api/auth/user-logout/route');
const meRoute = await import('../../src/app/api/auth/me/route');
const googleStartRoute = await import('../../src/app/api/auth/google/start/route');
const googleCallbackRoute = await import('../../src/app/api/auth/google/callback/route');
const supportStatusRoute = await import('../../src/app/api/support/status/route');
const supportChatRoute = await import('../../src/app/api/support/chat/route');
const supportHistoryRoute = await import('../../src/app/api/support/history/route');
const siteInfoRoute = await import('../../src/app/api/public/site-info/route');
const settingsRoute = await import('../../src/app/api/settings/route');
const officialBotRoute = await import('../../src/app/api/official-bot/route');
const customersRoute = await import('../../src/app/api/admin/customers/route');

const jsonReq = (url: string, body?: unknown, extra?: RequestInit): Request =>
  new Request(`http://localhost:3000${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...extra,
  });

const withCookie = (url: string, cookie: string): Request =>
  new Request(`http://localhost:3000${url}`, { headers: { cookie } });

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /nurae_session=([^;]+)/.exec(setCookie);
  expect(m, 'expected a nurae_session cookie').toBeTruthy();
  return `nurae_session=${m![1]}`;
}

installTelegramStub();

afterAll(async () => {
  resetTelegramStub();
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Official bot seeding
// ---------------------------------------------------------------------------

describe('official bot seeding', () => {
  test('is idempotent — same id on repeat, project + bot exist', async () => {
    const first = await ensureOfficialBot();
    expect(first).toBeTruthy();
    const second = await ensureOfficialBot();
    expect(second).toBe(first);

    const bot = await db.bot.findUnique({ where: { id: first! } });
    expect(bot?.name).toBe('NURAE CS Bot');
    const project = await db.project.findUnique({ where: { id: bot!.projectId } });
    expect(project?.name).toBe('NURAE Official');
    // Seeded without any keys — the admin fills them in.
    expect(bot?.telegramTokenRef).toBeNull();
    expect(bot?.apiKeyRef).toBeNull();
    expect(bot?.provider).toBe('openrouter');
  });

  test('status starts unready and the admin endpoint hides secrets', async () => {
    const res = await officialBotRoute.GET(jsonReq('/api/official-bot'));
    const body = (await res.json()) as {
      official: { ready: boolean; hasApiKey: boolean; hasTelegramToken: boolean };
      bot: { systemPrompt: string } | null;
    };
    expect(res.status).toBe(200);
    expect(body.official.ready).toBe(false);
    expect(body.official.hasApiKey).toBe(false);
    expect(body.official.hasTelegramToken).toBe(false);
    expect(body.bot?.systemPrompt).toContain('NURAE');
    // The DTO never carries secret material.
    expect(JSON.stringify(body)).not.toContain('v1:');
  });

  test('GET exposes the official prompt rebuilt from site settings', async () => {
    const res = await officialBotRoute.GET(jsonReq('/api/official-bot'));
    const body = (await res.json()) as { officialPrompt?: string };
    expect(res.status).toBe(200);
    expect(typeof body.officialPrompt).toBe('string');
    expect(body.officialPrompt).toContain('customer-support assistant');
  });
});

// ---------------------------------------------------------------------------
// Official CS prompt + legacy zai migration + mailer hardening
// ---------------------------------------------------------------------------

describe('official bot maintenance', () => {
  test('officialBotPrompt is rich, bounded, and reflects site settings', async () => {
    const { officialBotPrompt, DEFAULT_SITE_INFO } = await import('../../src/lib/nurae/auth/settings');
    const { LIMITS } = await import('../../src/lib/nurae/validation');
    const prompt = officialBotPrompt({
      ...DEFAULT_SITE_INFO,
      supportEmail: 'help@nurae.app',
      telegramHandle: '@nurae_support',
    });
    expect(prompt.length).toBeGreaterThan(400); // substantive, not a stub
    expect(prompt.length).toBeLessThanOrEqual(LIMITS.systemPromptMax);
    expect(prompt).toContain('help@nurae.app'); // escalation path baked in
    expect(prompt).toContain('@nurae_support');
    expect(prompt).toContain('@BotFather'); // real troubleshooting knowledge
    expect(prompt).not.toContain('undefined');
  });

  test('migrateLegacyZaiBots maps retired provider rows to openrouter', async () => {
    const { migrateLegacyZaiBots } = await import('../../src/lib/nurae/auth/official-bot');
    const officialBot = await db.bot.findUnique({ where: { id: (await ensureOfficialBot())! } });
    const projectId = officialBot!.projectId;
    const legacy = await db.bot.create({
      data: {
        projectId,
        name: 'Legacy Zai Bot',
        systemPrompt: 'legacy',
        provider: 'zai',
        model: 'glm-4.5-flash',
      },
    });
    const kept = await db.bot.create({
      data: {
        projectId,
        name: 'Custom Model Bot',
        systemPrompt: 'kept',
        provider: 'zai',
        model: 'glm/my-own-model',
      },
    });
    const migrated = await migrateLegacyZaiBots();
    expect(migrated).toBeGreaterThanOrEqual(2);
    const afterLegacy = await db.bot.findUnique({ where: { id: legacy.id } });
    expect(afterLegacy?.provider).toBe('openrouter');
    expect(afterLegacy?.model).toBe('openrouter/free');
    const afterKept = await db.bot.findUnique({ where: { id: kept.id } });
    expect(afterKept?.model).toBe('openrouter/free'); // glm/* -> free router
    // A migration log row is written for the operator.
    const logs = await db.log.findMany({ where: { botId: legacy.id, event: 'BOT_MIGRATED' } });
    expect(logs.length).toBe(1);
    // Idempotent: second run finds nothing.
    expect(await migrateLegacyZaiBots()).toBe(0);
    await db.bot.delete({ where: { id: legacy.id } });
    await db.bot.delete({ where: { id: kept.id } });
  });

  test('gmailConfig strips whitespace from the app password (Google shows it grouped)', async () => {
    const { gmailConfig } = await import('../../src/lib/nurae/auth/mailer');
    const prevUser = process.env.NURAE_GMAIL_USER;
    const prevPass = process.env.NURAE_GMAIL_APP_PASSWORD;
    try {
      process.env.NURAE_GMAIL_USER = 'owner@gmail.com';
      process.env.NURAE_GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
      expect(gmailConfig()).toEqual({ user: 'owner@gmail.com', pass: 'abcdefghijklmnop' });
      process.env.NURAE_GMAIL_APP_PASSWORD = 'abcdefghijklmnop';
      expect(gmailConfig()?.pass).toBe('abcdefghijklmnop');
    } finally {
      if (prevUser === undefined) delete process.env.NURAE_GMAIL_USER;
      else process.env.NURAE_GMAIL_USER = prevUser;
      if (prevPass === undefined) delete process.env.NURAE_GMAIL_APP_PASSWORD;
      else process.env.NURAE_GMAIL_APP_PASSWORD = prevPass;
    }
  });

  test('mailFailureHint maps raw SMTP errors to actionable guidance', async () => {
    const { mailFailureHint } = await import('../../src/lib/nurae/auth/mailer');
    expect(mailFailureHint('Invalid login: 535-5.7.8 Username and Password not accepted')).toContain('app password');
    expect(mailFailureHint('getaddrinfo ENOTFOUND smtp.gmail.com')).toContain('internet connection');
    expect(mailFailureHint('something unclassified')).toContain('server logs');
  });
});

// ---------------------------------------------------------------------------
// Customer registration → verification → session flow
// ---------------------------------------------------------------------------

describe('customer auth flow', () => {
  test('register issues a dev code when Gmail is not configured', async () => {
    const res = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'hunter2hunter2' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; devCode?: string; notice?: string };
    expect(body.ok).toBe(true);
    expect(body.devCode).toMatch(/^\d{6}$/); // SMTP unset in tests → dev code
    expect(body.notice).toBeTruthy();
  });

  test('register rejects duplicate verified emails with 409', async () => {
    const first = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'hunter2hunter2' }),
    );
    const code = ((await first.json()) as { devCode: string }).devCode;
    await verifyRoute.POST(jsonReq('/api/auth/verify', { email: 'bob@example.com', code }));

    const dup = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Bob2', email: 'bob@example.com', password: 'hunter2hunter2' }),
    );
    expect(dup.status).toBe(409);
  });

  test('register re-issues a fresh code for an UNVERIFIED duplicate (no 409)', async () => {
    await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Cara', email: 'cara@example.com', password: 'hunter2hunter2' }),
    );
    const again = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Cara', email: 'cara@example.com', password: 'otherpassword1' }),
    );
    expect(again.status).toBe(200);
  });

  test('verify: wrong code → 400, right code → 200 + session cookie', async () => {
    const reg = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Dan', email: 'dan@example.com', password: 'hunter2hunter2' }),
    );
    const code = ((await reg.json()) as { devCode: string }).devCode;

    const bad = await verifyRoute.POST(jsonReq('/api/auth/verify', { email: 'dan@example.com', code: '000000' }));
    expect(bad.status).toBe(400);

    const good = await verifyRoute.POST(jsonReq('/api/auth/verify', { email: 'dan@example.com', code }));
    expect(good.status).toBe(200);
    const cookie = sessionCookie(good);

    const me = await meRoute.GET(withCookie('/api/auth/me', cookie));
    const body = (await me.json()) as { user: { email: string; emailVerified: boolean; hasPassword: boolean } | null };
    expect(body.user?.email).toBe('dan@example.com');
    expect(body.user?.emailVerified).toBe(true);
    expect(body.user?.hasPassword).toBe(true);
  });

  test('codes are stored hashed, never in plaintext', async () => {
    const reg = await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'hunter2hunter2' }),
    );
    const code = ((await reg.json()) as { devCode: string }).devCode;
    const rows = await db.verificationToken.findMany({
      where: { user: { email: 'eve@example.com' }, purpose: 'email_verify' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.codeHash).not.toBe(code);
      expect(row.codeHash.startsWith('scrypt$')).toBe(true);
    }
  });

  test('user login: wrong password → 401, right password → session; logout kills it', async () => {
    const ok = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'dan@example.com', password: 'hunter2hunter2' }),
    );
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok);

    const bad = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'dan@example.com', password: 'wrongwrongwrong' }),
    );
    expect(bad.status).toBe(401);

    const unknown = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'ghost@example.com', password: 'wrongwrongwrong' }),
    );
    expect(unknown.status).toBe(401); // uniform error — no account enumeration

    const out = await userLogoutRoute.POST(withCookie('/api/auth/user-logout', cookie));
    expect(out.status).toBe(200);
    const me = await meRoute.GET(withCookie('/api/auth/me', cookie));
    const body = (await me.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });

  test('unverified accounts cannot sign in (403 points back to verification)', async () => {
    // cara re-registered in the test above → her password is now 'otherpassword1'.
    const res = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'cara@example.com', password: 'otherpassword1' }),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Google sign-in (configured/unconfigured + CSRF state)
// ---------------------------------------------------------------------------

describe('google sign-in', () => {
  test('start returns 501 JSON when not configured', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/google/start');
    const res = await googleStartRoute.GET(req);
    expect(res.status).toBe(501);
  });

  test('configured: start 302s to Google with a state cookie', async () => {
    process.env.NURAE_GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.NURAE_GOOGLE_CLIENT_SECRET = 'test-client-secret';
    try {
      const res = await googleStartRoute.GET(new NextRequest('http://localhost:3000/api/auth/google/start'));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('accounts.google.com');
      expect(res.headers.get('location')).toContain('client_id=test-client-id');
      expect(res.headers.get('location')).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fgoogle%2Fcallback');
      expect(res.headers.get('set-cookie')).toContain('nurae_oauth_state=');
    } finally {
      process.env.NURAE_GOOGLE_CLIENT_ID = '';
      process.env.NURAE_GOOGLE_CLIENT_SECRET = '';
    }
  });

  test('callback with a bad/missing state is rejected (CSRF) without any network', async () => {
    process.env.NURAE_GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.NURAE_GOOGLE_CLIENT_SECRET = 'test-client-secret';
    try {
      const req = new NextRequest('http://localhost:3000/api/auth/google/callback?code=abc&state=tampered');
      const res = await googleCallbackRoute.GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('auth_error=invalid-state');
    } finally {
      process.env.NURAE_GOOGLE_CLIENT_ID = '';
      process.env.NURAE_GOOGLE_CLIENT_SECRET = '';
    }
  });
});

// ---------------------------------------------------------------------------
// Support chat (the official bot on the web)
// ---------------------------------------------------------------------------

describe('support chat', () => {
  test('status reports unconfigured + site info', async () => {
    const res = await supportStatusRoute.GET();
    const body = (await res.json()) as { configured: boolean; site: { siteName: string } };
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false); // no AI key anywhere in tests
    expect(body.site.siteName).toBe('NURAE');
  });

  test('chat requires a signed-in, verified customer', async () => {
    const anon = await supportChatRoute.POST(jsonReq('/api/support/chat', { message: 'hello' }));
    expect(anon.status).toBe(401);

    // Unverified user (fay) cannot chat either.
    await registerRoute.POST(
      jsonReq('/api/auth/register', { name: 'Fay', email: 'fay@example.com', password: 'hunter2hunter2' }),
    );
    // Deliberately NOT verifying fay.
    const login = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'fay@example.com', password: 'hunter2hunter2' }),
    );
    expect(login.status).toBe(403); // login itself is blocked pre-verification
  });

  test('unconfigured bot → 503 bot_not_configured (honest failure)', async () => {
    const login = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'dan@example.com', password: 'hunter2hunter2' }),
    );
    const cookie = sessionCookie(login);
    const res = await supportChatRoute.POST(
      jsonReq('/api/support/chat', { message: 'hello there' }, { headers: { 'Content-Type': 'application/json', cookie } }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bot_not_configured');
  });

  test('configured bot answers through the AI stub, persists memory per user', async () => {
    // Point the official bot at the stubbed OpenAI-compatible endpoint.
    const botId = (await ensureOfficialBot())!;
    await db.bot.update({
      where: { id: botId },
      data: {
        provider: 'custom',
        baseUrl: `${TELEGRAM_STUB_BASE}/v1`,
        apiKeyRef: SecretManager.encrypt('stub-key'),
      },
    });

    const login = await userLoginRoute.POST(
      jsonReq('/api/auth/user-login', { email: 'dan@example.com', password: 'hunter2hunter2' }),
    );
    const cookie = sessionCookie(login);
    const res = await supportChatRoute.POST(
      jsonReq('/api/support/chat', { message: 'What is NURAE?' }, { headers: { 'Content-Type': 'application/json', cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string };
    expect(body.reply).toBe('stubbed AI reply');

    const hist = await supportHistoryRoute.GET(withCookie('/api/support/history', cookie));
    const h = (await hist.json()) as { messages: Array<{ role: string; content: string }> };
    expect(h.messages.some((m) => m.role === 'user' && m.content === 'What is NURAE?')).toBe(true);
    expect(h.messages.some((m) => m.role === 'assistant' && m.content === 'stubbed AI reply')).toBe(true);

    // Chat rows are keyed web:<userId> under the official bot.
    const conv = await db.conversation.findFirst({ where: { botId, chatId: { startsWith: 'web:' } } });
    expect(conv).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Site settings + public site info
// ---------------------------------------------------------------------------

describe('site settings', () => {
  test('PUT persists values, GET returns them, public site-info exposes the whitelist', async () => {
    const put = await settingsRoute.PUT(
      jsonReq('/api/settings', {
        siteName: 'NURAE',
        tagline: 'Bots for everyone.',
        supportEmail: 'help@fraziym.dev',
        telegramHandle: '@nurae_bot',
        welcomeMessage: 'Welcome! How can we help?',
      }),
    );
    expect(put.status).toBe(200);

    const get = await settingsRoute.GET(jsonReq('/api/settings'));
    const body = (await get.json()) as { settings: { tagline: string; telegramHandle: string } };
    expect(body.settings.tagline).toBe('Bots for everyone.');
    expect(body.settings.telegramHandle).toBe('@nurae_bot');

    const pub = await siteInfoRoute.GET();
    const pubBody = (await pub.json()) as {
      site: { tagline: string; supportEmail: string };
      auth: { googleEnabled: boolean; gmailEnabled: boolean };
    };
    expect(pubBody.site.tagline).toBe('Bots for everyone.');
    expect(pubBody.site.supportEmail).toBe('help@fraziym.dev');
    expect(pubBody.auth.googleEnabled).toBe(false);
    expect(pubBody.auth.gmailEnabled).toBe(false);
  });

  test('invalid handle form → 422', async () => {
    const res = await settingsRoute.PUT(jsonReq('/api/settings', { telegramHandle: 'nurae_bot' }));
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Customers directory
// ---------------------------------------------------------------------------

describe('customers directory', () => {
  test('lists customers with details; deletion is NOT an admin power (BR-029)', async () => {
    const list = await customersRoute.GET(jsonReq('/api/admin/customers'));
    const body = (await list.json()) as {
      total: number;
      customers: Array<{
        id: string;
        email: string;
        signupMethod: string;
        emailVerified: boolean;
        hasPassword: boolean;
      }>;
    };
    expect(list.status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(4); // ada, bob, dan, eve, fay, …
    const dan = body.customers.find((c) => c.email === 'dan@example.com');
    expect(dan).toBeTruthy();
    expect(dan!.signupMethod).toBe('email');
    expect(dan!.emailVerified).toBe(true);
    // Password hashes / session tokens never leave the server.
    expect(JSON.stringify(body)).not.toContain('scrypt$');

    // The owner removed account deletion from the admin's powers (V00.09.000):
    // the endpoint module must not exist, and dan's account must still be here.
    const { existsSync } = await import('node:fs');
    expect(existsSync('src/app/api/admin/customers/[id]/route.ts')).toBe(false);
    expect(await db.user.findUnique({ where: { id: dan!.id } })).not.toBeNull();
  });

  test('optional enrichments degrade to zeros when the DB lags schema (BR-031)', async () => {
    const errSpy = console.error;
    const errors: string[] = [];
    console.error = (msg: unknown) => errors.push(String(msg));
    try {
      const botSpy = vi.spyOn(db.bot, 'groupBy').mockRejectedValue(new Error('no such column: owner_id'));
      const settingSpy = vi
        .spyOn(db.siteSetting, 'findUnique')
        .mockRejectedValue(new Error('no such table: site_settings'));

      const res = await customersRoute.GET(jsonReq('/api/admin/customers'));
      expect(res.status).toBe(200); // the directory survives — zero-enriched, not 500
      const body = (await res.json()) as { total: number; customers: Array<{ botCount: number }> };
      expect(body.total).toBeGreaterThanOrEqual(4);
      expect(body.customers.every((c) => c.botCount === 0)).toBe(true);
      expect(errors.join(' ')).toContain('bot counts unavailable');
      expect(errors.join(' ')).toContain('chat volume unavailable');

      botSpy.mockRestore();
      settingSpy.mockRestore();
    } finally {
      console.error = errSpy;
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (kept LAST — the per-IP login bucket must stay unsaturated
// for the flow tests above; this test also pins its own IP header)
// ---------------------------------------------------------------------------

describe('public endpoint rate limiting', () => {
  test('11th login burst from one IP is throttled with 429', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await userLoginRoute.POST(
        new Request('http://localhost:3000/api/auth/user-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
          body: JSON.stringify({ email: `ratelimit${i}@example.com`, password: 'whatever123' }),
        }),
      );
    }
    expect(last!.status).toBe(429);
  });
});
