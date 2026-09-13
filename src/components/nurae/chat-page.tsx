'use client';

/**
 * NURAE — /chat page: the official NURAE CS Bot web chat.
 * Requires a signed-in customer; signed-out visitors get a sign-in prompt.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { SupportChat } from '@/components/nurae/support-chat';
import { SiteInfoResponse, nuraeApi } from '@/lib/nurae-client/api';

export function ChatPage() {
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

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader siteName={siteName} user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {user ? (
          <SupportChat
            user={user}
            welcomeMessage={
              siteInfo?.site.welcomeMessage ||
              'Hi! I am the official NURAE support bot. Ask me anything about NURAE.'
            }
            botUsername={null}
          />
        ) : (
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-card p-8 text-center">
            <h1 className="text-lg font-semibold text-foreground">Sign in to chat</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The NURAE CS Bot is available to customer accounts. Sign in or create one in under a minute.
            </p>
            <Link href="/" className="mt-5 inline-flex">
              <Button>Go to sign in</Button>
            </Link>
          </div>
        )}
      </main>
      <SiteFooter siteName={siteName} />
    </div>
  );
}
