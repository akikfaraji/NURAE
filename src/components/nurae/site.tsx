'use client';

/**
 * NURAE — public site HOME page (localhost:3000 for normal users).
 *
 * Logged out: hero + features + auth card
 *   • email + password sign-up → 6-digit Gmail verification code
 *   • Google sign-in (when configured)
 * Logged in: welcome strip + quick cards (open the CS chat, help, about).
 *
 * The chat itself lives at /chat; other user pages: /help, /about.
 * Design language: premium black, monochrome SVG icons only.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SiteFooter,
  SiteHeader,
  SiteSplash,
  useSiteUser,
} from '@/components/nurae/site-shell';
import {
  ApiError,
  SessionUserDTO,
  SiteInfoResponse,
  nuraeApi,
} from '@/lib/nurae-client/api';
import {
  ArrowRightIcon,
  BoltIcon,
  BotIcon,
  CheckIcon,
  GoogleIcon,
  MailIcon,
  ShieldIcon,
  TelegramIcon,
} from '@/components/nurae/icons';

export function SiteHome() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, checked, setUser, signOut } = useSiteUser();
  const [siteInfo, setSiteInfo] = useState<SiteInfoResponse | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    (async () => {
      const err = params.get('auth_error');
      if (err) setAuthError(err.replace(/-/g, ' '));
      if (params.get('welcome')) setWelcome(true);
      try {
        setSiteInfo(await nuraeApi.siteInfo());
      } catch {
        setSiteInfo({
          site: {
            siteName: 'NURAE',
            tagline: 'Launch your own AI Telegram bot in minutes — no code, no servers, no hassle.',
            supportEmail: '',
            telegramHandle: '',
            welcomeMessage: '',
          },
          auth: { googleEnabled: false, gmailEnabled: false },
        });
      }
    })();
  }, [params]);

  if (!checked) return <SiteSplash />;

  const siteName = siteInfo?.site.siteName ?? 'NURAE';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader siteName={siteName} user={user} onSignOut={signOut} />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_50%_-10%,hsl(0_0%_100%/0.07),transparent)]"
          />
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-[11px] uppercase tracking-widest text-muted-foreground">
                <BoltIcon className="h-3.5 w-3.5" /> FRAZIYM TECH &amp; AI
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                Your own AI Telegram bot,
                <br />
                <span className="text-muted-foreground">live in minutes.</span>
              </h1>
              <p className="mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">{siteInfo?.site.tagline}</p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {user ? (
                  <Link href="/chat" className="inline-flex">
                    <Button size="lg" className="gap-2">
                      Open the chat <ArrowRightIcon className="h-4 w-4" />
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="lg"
                    className="gap-2"
                    onClick={() => document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    Get started free <ArrowRightIcon className="h-4 w-4" />
                  </Button>
                )}
                <Link href="/help" className="inline-flex">
                  <Button size="lg" variant="outline">
                    Help &amp; FAQ
                  </Button>
                </Link>
                {siteInfo?.site.telegramHandle && (
                  <a
                    href={`https://t.me/${siteInfo.site.telegramHandle.replace('@', '')}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button size="lg" variant="outline" className="gap-2">
                      <TelegramIcon className="h-4 w-4" /> Telegram
                    </Button>
                  </a>
                )}
              </div>
              {siteInfo?.site.supportEmail && (
                <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
                  <MailIcon className="h-3.5 w-3.5" /> Support: {siteInfo.site.supportEmail}
                </p>
              )}
            </div>

            {/* Auth card (signed-out only) — signed-in users get quick links */}
            <div id="auth" className="scroll-mt-24">
              {user ? (
                <SignedInCard siteName={siteName} email={user.email} welcome={welcome} />
              ) : (
                <AuthCard
                  siteInfo={siteInfo}
                  siteName={siteName}
                  authError={authError}
                  clearAuthError={() => setAuthError(null)}
                  onAuthenticated={(u) => {
                    setUser(u);
                    router.push('/chat');
                  }}
                />
              )}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-border">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:grid-cols-3 sm:px-6">
            <Feature
              icon={<BotIcon className="h-5 w-5" />}
              title="No-code bot builder"
              body="Name your bot, pick a provider, paste the token from @BotFather — the dashboard does the rest, from Telegram webhooks to conversation memory."
            />
            <Feature
              icon={<BoltIcon className="h-5 w-5" />}
              title="Free AI included"
              body="OpenRouter free models are the default brain. One free key runs your bots — upgrade to any provider whenever you want."
            />
            <Feature
              icon={<ShieldIcon className="h-5 w-5" />}
              title="Keys stay secret"
              body="Tokens and API keys are encrypted at rest (AES-256-GCM), never logged, never returned by any API. You stay in control."
            />
          </div>
        </section>
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}

/** Signed-in view of the auth-card slot: quick links instead of the form. */
function SignedInCard({
  siteName,
  email,
  welcome,
}: {
  siteName: string;
  email: string;
  welcome: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-lg shadow-black/40">
      {welcome && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-foreground">
          <CheckIcon className="h-3.5 w-3.5" /> Signed in with Google — welcome to {siteName}.
        </div>
      )}
      <h2 className="text-lg font-semibold text-foreground">You are signed in</h2>
      <p className="mt-1 text-sm text-muted-foreground">{email}</p>
      <div className="mt-5 grid gap-3">
        <Link href="/chat" className="block">
          <Button className="w-full gap-2">
            <BotIcon className="h-4 w-4" /> Chat with the NURAE CS Bot
          </Button>
        </Link>
        <div className="grid grid-cols-2 gap-3">
          <Link href="/help" className="block">
            <Button variant="outline" className="w-full">Help &amp; FAQ</Button>
          </Link>
          <Link href="/about" className="block">
            <Button variant="outline" className="w-full">About</Button>
          </Link>
        </div>
      </div>
      <p className="mt-5 border-t border-border pt-4 text-center text-[10px] uppercase tracking-widest text-muted-foreground">
        {siteName} · FRAZIYM TECH &amp; AI
      </p>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/50 text-foreground">
        {icon}
      </span>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth card — sign in / create account / verify code
// ---------------------------------------------------------------------------

type AuthStep = 'signin' | 'signup' | 'verify';

function AuthCard({
  siteInfo,
  siteName,
  authError,
  clearAuthError,
  onAuthenticated,
}: {
  siteInfo: SiteInfoResponse | null;
  siteName: string;
  authError: string | null;
  clearAuthError: () => void;
  onAuthenticated: (user: SessionUserDTO) => void;
}) {
  const [step, setStep] = useState<AuthStep>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mailError, setMailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const googleEnabled = siteInfo?.auth.googleEnabled ?? false;

  const switchStep = (next: AuthStep) => {
    clearAuthError();
    setError(null);
    setNotice(null);
    setMailError(null);
    setStep(next);
  };

  const submitSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await nuraeApi.userLogin(email.trim().toLowerCase(), password);
      onAuthenticated(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  // (Re-)issue a verification code. The register endpoint is idempotent for
  // unverified accounts, so resending is just another register call with the
  // credentials already in state. Old codes are invalidated server-side — the
  // NEWEST email is the one that counts.
  const issueCode = async () => {
    const r = await nuraeApi.register(name.trim(), email.trim().toLowerCase(), password);
    if (r.devCode) setDevCode(r.devCode);
    else setDevCode(null);
    setMailError(r.mailError ?? null);
    setNotice(
      r.devCode
        ? 'Gmail is not configured on this server — use the dev code below to verify.'
        : r.mailError
          ? null
          : `A new 6-digit code was sent to ${email}. Use the NEWEST email — older codes no longer work. It expires in 15 minutes.`,
    );
    return r;
  };

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await issueCode();
      setStep('verify');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await issueCode();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend the code');
    } finally {
      setBusy(false);
    }
  };

  const submitVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await nuraeApi.verifyEmail(email.trim().toLowerCase(), code.trim());
      // Verified + session cookie set — load the fresh identity.
      const me = await nuraeApi.me();
      if (me.user) onAuthenticated(me.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-lg shadow-black/40">
      {authError && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs capitalize text-destructive">
          Google sign-in failed: {authError}
        </div>
      )}

      {step === 'verify' ? (
        <form onSubmit={submitVerify} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Verify your email</h2>
            <p className="mt-1 text-sm text-muted-foreground">{notice ?? `Enter the 6-digit code sent to ${email}.`}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Not in your inbox? Check the <span className="font-medium text-foreground">SPAM / Promotions</span> folder —
            Gmail sometimes files verification mail there. Use the NEWEST email; older codes stop working.
          </div>
          {mailError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert">
              <p className="font-medium">The email could not be sent — no code will arrive.</p>
              <p className="mt-1 opacity-90">{mailError}</p>
            </div>
          )}
          {devCode && (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5 text-center">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Dev verification code</div>
              <div className="mt-1 font-mono text-2xl font-bold tracking-[0.4em] text-foreground">{devCode}</div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="verify-code">Verification code</Label>
            <Input
              id="verify-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="text-center font-mono text-lg tracking-[0.5em]"
            />
          </div>
          {error && <FormError message={error} />}
          <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </Button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={resend}
              disabled={busy}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              Resend code
            </button>
            <button
              type="button"
              onClick={() => switchStep('signin')}
              className="text-muted-foreground hover:text-foreground"
            >
              Back to sign in
            </button>
          </div>
        </form>) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {(['signin', 'signup'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => switchStep(s)}
                className={
                  'rounded-md px-3 py-1.5 text-sm transition-colors ' +
                  (step === s ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {s === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {googleEnabled && (
            <>
              <a href="/api/auth/google/start" className="block">
                <Button type="button" variant="outline" className="w-full gap-2">
                  <GoogleIcon className="h-4 w-4" />
                  {step === 'signin' ? 'Sign in with Google' : 'Sign up with Google'}
                </Button>
              </a>
              <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-widest text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or with email <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          {step === 'signin' ? (
            <form onSubmit={submitSignin} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signin-password">Password</Label>
                <Input
                  id="signin-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <FormError message={error} />}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                New here?{' '}
                <button type="button" className="text-foreground underline-offset-4 hover:underline" onClick={() => switchStep('signup')}>
                  Create an account
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={submitSignup} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="signup-name">Name</Label>
                <Input id="signup-name" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <FormError message={error} />}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                A verification code will be sent to your email.
              </p>
            </form>
          )}
        </>
      )}

      <p className="mt-5 border-t border-border pt-4 text-center text-[10px] uppercase tracking-widest text-muted-foreground">
        {siteName} · FRAZIYM TECH &amp; AI
      </p>
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
      {message}
    </div>
  );
}
