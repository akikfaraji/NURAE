'use client';

/**
 * NURAE — /<username>_<uid>/dashboard: the user's vanity dashboard route.
 * The slug is resolved against the signed-in session: the owner sees their
 * dashboard at their own URL; anyone else (or a signed-out visitor) is
 * bounced to their own canonical destination. The slug is identity-flavored,
 * never an authorization boundary.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSiteUser } from '@/components/nurae/site-shell';
import { UserDashboardView } from '@/components/nurae/user-dashboard';
import { userSlug } from '@/lib/nurae/slug';

export default function Page() {
  const params = useParams<{ slug: string }>();
  const { user, checked } = useSiteUser();
  const router = useRouter();

  useEffect(() => {
    if (!checked) return;
    if (!user) {
      router.replace('/');
      return;
    }
    if (userSlug(user) !== params.slug) {
      // Foreign or stale slug → the user's own dashboard.
      router.replace('/dashboard');
    }
  }, [checked, user, params.slug, router]);

  if (checked && user && userSlug(user) === params.slug) {
    return <UserDashboardView slugOverride={params.slug} />;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-xs text-muted-foreground" role="status">Loading…</p>
    </div>
  );
}
