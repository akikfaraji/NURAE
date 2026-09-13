'use client';

/**
 * NURAE — /about page: what NURAE is, who runs it, how to reach it.
 * Contact channels come live from the admin-configured site settings.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { MailIcon, TelegramIcon } from '@/components/nurae/icons';
import { SiteInfoResponse, nuraeApi } from '@/lib/nurae-client/api';
import { NURAE_VERSION } from '@/lib/nurae/version';

export function AboutPage() {
  const { user, checked, signOut } = useSiteUser();
  const [siteInfo, setSiteInfo] = useState<SiteInfoResponse | null>(null);

  useEffect(() => {
    nuraeApi
      .siteInfo()
      .then(setSiteInfo)
      .catch(() => setSiteInfo(null));
  }, []);

  if (!checked) return <SiteSplash />;

  const siteName = siteInfo?.site.siteName ?? 'NURAE';
  const supportEmail = siteInfo?.site.supportEmail ?? '';
  const telegramHandle = siteInfo?.site.telegramHandle ?? '';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader siteName={siteName} user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">About {siteName}</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          {siteName} is a platform by <strong className="text-foreground">FRAZIYM TECH &amp; AI</strong> that puts
          AI-powered Telegram bots in anyone&apos;s hands — no code, no servers, no DevOps. You describe the bot,
          we run the infrastructure: Telegram connectivity, conversation memory, AI providers and key security.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <AboutTile title="No-code" body="Bots are configured in minutes — name, provider, token. Nothing to install." />
          <AboutTile title="Free AI tier" body="OpenRouter free models are the default brain. One free key, real answers." />
          <AboutTile title="Private by design" body="Keys are encrypted at rest and never logged. Your data stays yours." />
        </div>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-widest text-muted-foreground">Contact</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {supportEmail && (
            <a href={`mailto:${supportEmail}`} className="inline-flex">
              <Button variant="outline" className="gap-2">
                <MailIcon className="h-4 w-4" /> {supportEmail}
              </Button>
            </a>
          )}
          {telegramHandle && (
            <a
              href={`https://t.me/${telegramHandle.replace('@', '')}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex"
            >
              <Button variant="outline" className="gap-2">
                <TelegramIcon className="h-4 w-4" /> {telegramHandle}
              </Button>
            </a>
          )}
          <Link href="/chat" className="inline-flex">
            <Button className="gap-2">Ask the CS Bot</Button>
          </Link>
        </div>

        <p className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
          {siteName} <span className="font-mono">{NURAE_VERSION}</span> · Autonomous Digital Operations System ·
          FRAZIYM TECH &amp; AI
        </p>
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}

function AboutTile({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
