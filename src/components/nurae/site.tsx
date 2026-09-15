'use client';

/**
 * NURAE — public site HOME.
 *
 * Signed out: a quiet typographic hero + the account form
 * (email + 6-digit Gmail code, Google when configured).
 * Signed in: the product is three links away — Chats, Agents, Bots.
 *
 * Referral links (?ref=CODE) are captured here and stored until the
 * sign-up call — the code travels with registration, never displayed.
 *
 * Design language: premium black, typography and spacing only — no gradient
 * blobs, no card grids, no pills.
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
import { GoogleIcon, MailIcon } from '@/components/nurae/icons';

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

      // Referral capture: keep the code until sign-up. Nothing is shown.
      const ref = params.get('ref');
      if (ref) {
        try {
          localStorage.setItem('nurae:ref', ref.trim().toUpperCase().slice(0, 32));
        } catch {
          /* private mode */
        }
      }

      try {
        setSiteInfo(await nuraeApi.siteInfo());
      } catch {
        setSiteInfo(null);
      }
    })();
  }, [params]);

  if (!checked) return <SiteSplash />;

  const siteName = siteInfo?.site.siteName ?? 'NURAE';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader variant={user ? 'app' : 'public'} user={user} onSignOut={signOut} />
      <main className="flex-1">
        {/* Hero — typography and space, nothing else */}
        <section>
          <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
            {user ? (
              <SignedInPanel email={user.email} welcome={welcome} siteName={siteName} />
            ) : (
              <div className="grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:gap-20">
                <div>
                  <h1 className="max-w-xl text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">
                    Chat is the interface.
                    <br />
                    <span className="text-muted-foreground">Agents are the workers.</span>
                  </h1>
                  <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">
                    {siteInfo?.site.tagline ??
                      'Build, run and improve AI-powered Telegram bots — talk to NURAE, hand real work to its agents, publish with one approval.'}
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      onClick={() => document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })}
                    >
                      Get started free
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <Link href="/featured">See the featured chat →</Link>
                    </Button>
                  </div>
                  {siteInfo?.site.supportEmail && (
                    <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
                      <MailIcon className="h-3.5 w-3.5" /> {siteInfo.site.supportEmail}
                    </p>
                  )}
                </div>
                <div id="auth" className="scroll-mt-24">
                  <AuthCard
                    googleEnabled={siteInfo?.auth.googleEnabled ?? false}
                    authError={authError}
                    clearAuthError={() => setAuthError(null)}
                    onAuthenticated={(u) => {
                      setUser(u);
                      router.push('/chats');
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* What NURAE is — three statements, no cards */}
        <section className="border-t border-border/60">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <dl className="grid gap-10 sm:grid-cols-3">
              <div>
                <dt className="text-sm font-medium text-foreground">Talk, or delegate</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Ask questions in <Link href="/chats" className="text-foreground underline-offset-4 hover:underline">Chats</Link>.
                  When something needs real work — building or changing a bot — it goes to an
                  <Link href="/chats/agents" className="text-foreground underline-offset-4 hover:underline"> agent</Link> that
                  actually does it, with your approval before anything goes live.
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-foreground">Bots that do more than chat</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Menu commands, inline buttons, keyword replies and mini-workflows — configured by
                  you or by the agent, tested against the real pipeline before publishing.
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-foreground">Yours, and private</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Tokens and keys are encrypted at rest and never returned by any API. Agents run
                  inside your account with audited, permission-checked tools.
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}

/** Signed-in hero: the product, three links. */
function SignedInPanel({
  email,
  welcome,
  siteName,
}: {
  email: string;
  welcome: boolean;
  siteName: string;
}) {
  return (
    <div className="max-w-xl">
      {welcome && (
        <p className="mb-4 text-xs text-muted-foreground">
          Signed in with Google — welcome to {siteName}.
        </p>
      )}
      <h1 className="text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">
        Welcome back.
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">{email}</p>
      <div className="mt-8 grid gap-px border-t border-l border-border/60 sm:grid-cols-3">
        <Link href="/chats" className="group block border-b border-border/60 p-4 transition-colors hover:bg-muted/40 sm:border-r">
          <span className="block text-sm text-foreground">Chats</span>
          <span className="mt-1 block text-xs text-muted-foreground">Talk with the AI</span>
        </Link>
        <Link href="/chats/agents" className="group block border-b border-border/60 p-4 transition-colors hover:bg-muted/40 sm:border-r">
          <span className="block text-sm text-foreground">Agents</span>
          <span className="mt-1 block text-xs text-muted-foreground">Hand over real work</span>
        </Link>
        <Link href="/bots" className="group block border-b border-border/60 p-4 transition-colors hover:bg-muted/40">
          <span className="block text-sm text-foreground">Bots</span>
          <span className="mt-1 block text-xs text-muted-foreground">Run what was built</span>
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth card — sign in / create account / verify code
// ---------------------------------------------------------------------------

type AuthStep = 'signin' | 'signup' | 'verify';

function AuthCard({
  googleEnabled,
  authError,
  clearAuthError,
  onAuthenticated,
}: {
  googleEnabled: boolean;
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
  // unverified accounts, so resending is just another register call. Old
  // codes are invalidated server-side — the NEWEST email is the one that counts.
  const issueCode = async () => {
    let ref: string | null = null;
    try {
      ref = localStorage.getItem('nurae:ref');
      localStorage.removeItem('nurae:ref');
    } catch {
      ref = null;
    }
    const r = await nuraeApi.register(
      name.trim(),
      email.trim().toLowerCase(),
      password,
      ref ?? undefined,
    );
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
      const me = await nuraeApi.me();
      if (me.user) onAuthenticated(me.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {authError && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs capitalize text-destructive">
          Google sign-in failed: {authError}
        </div>
      )}

      {step === 'verify' ? (
        <form onSubmit={submitVerify} className="space-y-4">
          <div>
            <h2 className="text-lg font-medium text-foreground">Verify your email</h2>
            <p className="mt-1 text-sm text-muted-foreground">{notice ?? `Enter the 6-digit code sent to ${email}.`}</p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Not in your inbox? Check the <span className="text-foreground">spam / Promotions</span> folder — Gmail
            sometimes files verification mail there. Use the newest email; older codes stop working.
          </p>
          {mailError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert">
              <p className="font-medium">The email could not be sent — no code will arrive.</p>
              <p className="mt-1 opacity-90">{mailError}</p>
            </div>
          )}
          {devCode && (
            <div className="rounded-md border border-border px-3 py-2.5 text-center">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Dev verification code</div>
              <div className="mt-1 font-mono text-2xl tracking-[0.4em] text-foreground">{devCode}</div>
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
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <Button type="submit" className="w-full" size="sm" disabled={busy || code.length !== 6}>
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
            <button type="button" onClick={() => switchStep('signin')} className="text-muted-foreground hover:text-foreground">
              Back to sign in
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="mb-5 flex gap-6 border-b border-border/60 text-xs">
            {(['signin', 'signup'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => switchStep(s)}
                className={
                  '-mb-px border-b pb-2 transition-colors ' +
                  (step === s
                    ? 'border-foreground font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground')
                }
              >
                {s === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {googleEnabled && (
            <>
              <Button type="button" variant="outline" className="w-full gap-2" size="sm" asChild>
                <a href="/api/auth/google/start">
                  <GoogleIcon className="h-4 w-4" />
                  {step === 'signin' ? 'Sign in with Google' : 'Sign up with Google'}
                </a>
              </Button>
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
                  className="bg-transparent"
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
                  className="bg-transparent"
                />
              </div>
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full" size="sm" disabled={busy}>
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
                <Input id="signup-name" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} className="bg-transparent" />
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
                  className="bg-transparent"
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
                  className="bg-transparent"
                />
              </div>
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full" size="sm" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                A verification code will be sent to your email.
              </p>
            </form>
          )}
        </>
      )}
    </div>
  );
}
