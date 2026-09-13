'use client';

/**
 * NURAE — /about page: what NURAE is, who runs it, how to reach it.
 * Contact channels come live from the admin-configured site settings.
 * (The version strip that used to duplicate the footer is gone — the
 * footer alone carries version + vendor now.)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { SiteInfoResponse, nuraeApi } from '@/lib/nurae-client/api';

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
      <SiteHeader variant={user ? 'app' : 'public'} user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">About {siteName}</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          {siteName} is a platform by <strong className="font-medium text-foreground">FRAZIYM TECH &amp; AI</strong> that puts
          AI-powered Telegram bots in anyone&apos;s hands — no code, no servers, no DevOps. You describe the bot,
          the platform runs the infrastructure: Telegram connectivity, conversation memory, AI providers and key security.
        </p>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          The model underneath is simple. <span className="text-foreground">Chat is the interface</span> — you talk
          the way you talk. <span className="text-foreground">Agents are the workers</span> — when a request needs
          real work, an agent performs it with audited, permission-checked tools.{' '}
          <span className="text-foreground">Bots are what gets built</span> — configured, tested and published from
          your account, with secrets encrypted at rest.
        </p>

        <h2 className="mt-10 text-xs font-medium uppercase tracking-widest text-muted-foreground">Contact</h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {supportEmail && (
            <a href={`mailto:${supportEmail}`} className="text-foreground underline-offset-4 hover:underline">
              {supportEmail}
            </a>
          )}
          {telegramHandle && (
            <a
              href={`https://t.me/${telegramHandle.replace('@', '')}`}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline-offset-4 hover:underline"
            >
              {telegramHandle}
            </a>
          )}
          <Link href="/chats" className="text-foreground underline-offset-4 hover:underline">
            Ask the CS bot
          </Link>
        </div>
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}
