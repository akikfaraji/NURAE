'use client';

/**
 * NURAE — /help page: customer help center & FAQ.
 * Static answers for the top questions (verification codes, bots, keys) plus
 * the live contact channels from site settings. Includes the spam-folder
 * guidance for verification mail (Gmail files OTP mail as spam sometimes).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { MailIcon, TelegramIcon } from '@/components/nurae/icons';
import { SiteInfoResponse, nuraeApi } from '@/lib/nurae-client/api';

const FAQ: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: 'I created an account but the 6-digit code never arrived',
    a: (
      <>
        <p>
          First, check the <strong>SPAM / Promotions</strong> tab — Gmail sometimes files verification mail there
          even though it is genuine. Open the newest message from us: the code is in the subject line and the body.
        </p>
        <p>
          Codes expire after <strong>15 minutes</strong>, and only the <strong>newest</strong> code works — if you
          pressed “Resend”, older codes are dead. Still nothing? Use “Resend code” once more, then contact support.
        </p>
      </>
    ),
  },
  {
    q: 'How do I create my own AI Telegram bot?',
    a: (
      <>
        <p>
          Ask the NURAE CS Bot in the chat — it walks you through it step by step. The short version: message
          <strong> @BotFather</strong> on Telegram to get a bot token, then the NURAE team connects it for you with
          your chosen AI provider (free OpenRouter models are the default brain).
        </p>
      </>
    ),
  },
  {
    q: 'What can I ask the NURAE CS Bot?',
    a: (
      <p>
        Anything about NURAE: what bots can do, providers and API keys, your account, verification codes, bot status,
        pricing of free models, and where to get help. It answers in your language.
      </p>
    ),
  },
  {
    q: 'Is my API key safe?',
    a: (
      <p>
        Yes. Keys and bot tokens are encrypted at rest (AES-256-GCM), never written to logs, and never returned by
        any API. They are only used server-side when your bot talks to its AI provider.
      </p>
    ),
  },
  {
    q: 'My bot stopped responding on Telegram',
    a: (
      <p>
        The support team can see bot status from the console. Common causes: the bot was stopped (it needs a manual
        start after a server restart), the Telegram token was revoked in @BotFather, or the AI provider rejected the
        key. Ask the CS Bot for the current status — it will escalate to the team when needed.
      </p>
    ),
  },
];

export function HelpPage() {
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
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Help &amp; FAQ</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Quick answers about accounts, verification codes and bots. Anything else — the{' '}
          <Link href="/chat" className="text-foreground underline underline-offset-2">
            NURAE CS Bot
          </Link>{' '}
          is one click away.
        </p>

        <div className="mt-8 space-y-4">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-xl border border-border bg-card px-5 py-4 open:pb-5"
            >
              <summary className="cursor-pointer list-none text-sm font-medium text-foreground marker:hidden">
                <span className="mr-2 inline-block text-muted-foreground transition-transform group-open:rotate-90">
                  ›
                </span>
                {item.q}
              </summary>
              <div className="mt-3 space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground [&_strong]:text-foreground">
                {item.a}
              </div>
            </details>
          ))}
        </div>

        {/* Contact card */}
        <div className="mt-10 rounded-xl border border-border bg-card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Still stuck?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The fastest route is the CS Bot chat — it escalates to the team with your chat history attached.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/chat" className="inline-flex">
              <Button className="gap-2">Open the chat</Button>
            </Link>
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
          </div>
        </div>
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}
