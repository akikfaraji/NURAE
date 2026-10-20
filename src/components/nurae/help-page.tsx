'use client';

/**
 * NURAE — /help page: customer help center & FAQ.
 * Static answers for the top questions (verification codes, bots, keys) plus
 * the live contact channels from site settings. Includes the spam-folder
 * guidance for verification mail (Gmail files OTP mail as spam sometimes).
 *
 * V4 depth pass: PageContainer (marketing light); the native <details> FAQ
 * became the shared Accordion inside a Glass panel — type="multiple", so
 * several answers can stay open, like the details blocks it replaced.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { MailIcon, TelegramIcon } from '@/components/nurae/icons';
import { SiteInfoResponse, nuraeApi } from '@/lib/nurae-client/api';
import { Glass, Kicker, PageContainer } from '@/components/nurae/depth';

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
          Two ways. <strong>Create with AI</strong>: go to <strong>Bots → Create with AI</strong> and describe the bot
          in a sentence — the Bot Builder agent writes the configuration, adds commands and buttons, and asks for
          your approval before anything goes live.
        </p>
        <p>
          Or create one manually and paste the token from <strong>@BotFather</strong> yourself. Either way you can
          test the bot against the real pipeline from its page before publishing it to Telegram.
        </p>
      </>
    ),
  },
  {
    q: 'What can I ask the NURAE CS Bot?',
    a: (
      <p>
        Anything about NURAE: what bots can do, providers and API keys, your account, verification codes, bot status,
        pricing of free models, and where to get help. It answers in your language — and when you ask it to
        <em> build</em> something, it hands the task to the Bot Builder agent with your files attached.
      </p>
    ),
  },
  {
    q: 'Is my API key safe?',
    a: (
      <p>
        Yes. Keys and bot tokens are encrypted at rest (AES-256-GCM), never written to logs, and never returned by
        any API. Agents work through a restricted tool layer that can only touch <em>your</em> bots and files —
        never another account’s, and nothing consequential happens without your explicit approval.
      </p>
    ),
  },
  {
    q: 'My bot stopped responding on Telegram',
    a: (
      <p>
        Open the bot under <strong>Bots</strong>: the status dot and the status detail tell you what happened. Common
        causes: the bot was unpublished (start it again from its page), the Telegram token was revoked in @BotFather,
        or the AI provider rejected the key. The Test console on the bot page runs the real pipeline so you can see
        exactly where it breaks.
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
    <div className="flex min-h-dvh flex-col">
      <SiteHeader variant={user ? 'app' : 'public'} user={user} onSignOut={signOut} />
      <PageContainer
        variant="marketing"
        kicker="Help center"
        title="Help & FAQ"
        description={
          <>
            Quick answers about accounts, verification codes and bots. Anything else — the{' '}
            <Link href="/chats" className="text-foreground underline underline-offset-2">
              NURAE CS Bot
            </Link>{' '}
            is one click away.
          </>
        }
        className="min-h-0 flex-1"
      >
        <Kicker className="mt-8">FAQ</Kicker>
        <Glass bleed className="mt-3 overflow-hidden">
          <Accordion type="multiple" className="w-full">
            {FAQ.map((item) => (
              <AccordionItem key={item.q} value={item.q} className="border-[color:var(--depth-line-soft)]">
                <AccordionTrigger className="px-4 py-3.5 text-left text-[13px] font-medium text-foreground hover:no-underline">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <div className="space-y-2 text-sm leading-relaxed text-muted-foreground [&_strong]:text-foreground">
                    {item.a}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Glass>

        {/* Contact card */}
        <Glass className="mt-10 p-6">
          <h2 className="n-kicker m-0 font-normal">Still stuck?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The fastest route is the CS Bot chat — it escalates to the team with your chat history attached.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button className="gap-2" asChild>
              <Link href="/chats">Open the chat</Link>
            </Button>
            {supportEmail && (
              <Button variant="outline" className="gap-2" asChild>
                <a href={`mailto:${supportEmail}`}>
                  <MailIcon className="h-4 w-4" /> {supportEmail}
                </a>
              </Button>
            )}
            {telegramHandle && (
              <Button variant="outline" className="gap-2" asChild>
                <a
                  href={`https://t.me/${telegramHandle.replace('@', '')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <TelegramIcon className="h-4 w-4" /> {telegramHandle}
                </a>
              </Button>
            )}
          </div>
        </Glass>
      </PageContainer>
      <SiteFooter siteName={siteName} />
    </div>
  );
}
