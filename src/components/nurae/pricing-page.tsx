'use client';

/**
 * NURAE — /pricing: pay-as-you-use by default, optional plans on top.
 * Plans are additive perks bought from the wallet — the free tier never
 * shrinks. The table reads the compiled catalog so code and copy cannot
 * drift; the plan cards mirror billing/plans.ts.
 *
 * V4 depth pass: PageContainer (marketing light), Glass panels, Kicker
 * labels. The Plus card carries the page's one ambient glow — Plus is the
 * plan this page's own copy points at ("a Plus plan exists for when your
 * usage is real"), so no invented badge is needed.
 */

import Link from 'next/link';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { DEFAULT_CATALOG, MICRO, STARS_PRESETS, TRIAL_DAYS } from '@/lib/nurae/billing/catalog';
import { PLANS } from '@/lib/nurae/billing/plan-catalog';
import { Glass, Kicker, PageContainer } from '@/components/nurae/depth';
import { cn } from '@/lib/utils';

const usd = (micros: number): string => {
  const out = (Math.abs(micros) / MICRO).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${micros < 0 ? '-' : ''}$${micros === 0 ? '0' : out}`;
};

const CRYPTO = ['TON (Gram)', 'BTC', 'USDT', 'ETH', 'LTC', 'TRX'];

export function PricingPage() {
  const { user, checked, signOut } = useSiteUser();

  if (!checked) return <SiteSplash />;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader variant={user ? 'app' : 'public'} user={user} onSignOut={signOut} />
      <PageContainer
        variant="marketing"
        kicker="Billing & tiers"
        title="Pay as you use — or boost it with a plan"
        description={
          <>
            Every feature has a per-unit price in the fractions of a cent, every account gets {TRIAL_DAYS} free
            days (the free server week), and every feature keeps a free daily allowance even after that. You top
            up when — and only when — your bots actually earn or need it. Want bigger allowances and hosting
            included? A plan does that; nothing else changes.
          </>
        }
        className="min-h-0 flex-1"
      >
        {/* Plans */}
        <section className="mt-10">
          <Kicker>Plans (optional, paid from your wallet)</Kicker>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <Glass
                key={plan.id}
                className={cn(
                  'flex flex-col',
                  plan.id === 'plus' &&
                    // The one glow on the page. `.n-glass` in globals.css is unlayered
                    // CSS, so border/shadow utilities need the important modifier to land.
                    'border-white/25! shadow-[0_0_44px_rgba(255,255,255,0.07)]!',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{plan.name}</span>
                  <span className="n-num text-sm text-foreground">
                    {plan.monthlyMicros === 0 ? '$0' : usd(plan.monthlyMicros)}
                    <span className="text-xs text-muted-foreground">/mo</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{plan.tagline}</p>
                <ul className="mt-3 space-y-1.5">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="text-xs text-muted-foreground">— {perk}</li>
                  ))}
                </ul>
              </Glass>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Plans never gate features — they make the numbers bigger. <Link href="/billing" className="underline">Billing → Your plan</Link> activates in one click from your wallet balance; same-plan renewals stack, so renewing early never costs you days.
          </p>
        </section>

        {/* Free week + free tier */}
        <section className="mt-10">
          <Kicker>Free, on every account</Kicker>
          <Glass bleed className="mt-3">
            <ul className="m-0 list-none divide-y divide-[color:var(--depth-line-soft)] p-0">
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">{TRIAL_DAYS}-day free server week</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  From the moment you sign up: hosting, AI, messages — everything free for a week. No card, no wallet needed.
                </span>
              </li>
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Free daily allowances, forever</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Each feature below includes a free quota every UTC day. Small bots often never leave the free tier.
                </span>
              </li>
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Premium days via invites</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Every friend who signs up with your invite link and verifies their email adds premium days —
                  all usage free while they last. <Link href="/billing" className="underline">Billing → invite</Link>.
                </span>
              </li>
            </ul>
          </Glass>
        </section>

        {/* Price table */}
        <section className="mt-10">
          <Kicker>Prices</Kicker>
          <Glass bleed className="mt-3 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th scope="col" className="h-8 px-4 text-left align-middle">
                      <span className="n-kicker">Feature</span>
                    </th>
                    <th scope="col" className="h-8 px-4 text-left align-middle">
                      <span className="n-kicker">Price</span>
                    </th>
                    <th scope="col" className="h-8 px-4 text-right align-middle">
                      <span className="n-kicker">Free daily</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DEFAULT_CATALOG.map((f) => (
                    <tr key={f.key}>
                      <td className="px-4 py-3 align-middle">
                        <span className="text-[13px] font-medium text-foreground">{f.displayName}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{f.description}</span>
                      </td>
                      <td className="px-4 align-middle">
                        <span className="n-num text-[13px] text-foreground">{usd(f.unitPriceMicros)}</span>{' '}
                        <span className="text-xs text-muted-foreground">/ {f.unit}</span>
                      </td>
                      <td className="px-4 text-right align-middle">
                        <span className="n-num text-xs text-muted-foreground">
                          {f.freeDailyUnits > 0 ? `${f.freeDailyUnits} free / day` : 'pay per use'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Glass>
          <p className="mt-3 text-xs text-muted-foreground">
            To put that in perspective: $1 of credits covers about 20,000 bot messages, or ~666 AI
            replies, or 100 days of hosting one bot. Bring your own AI provider key and bot AI replies
            cost you nothing at all.
          </p>
        </section>

        {/* Payment methods */}
        <section className="mt-10">
          <Kicker>Top-up methods</Kicker>
          <Glass bleed className="mt-3">
            <ul className="m-0 list-none divide-y divide-[color:var(--depth-line-soft)] p-0">
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Telegram Stars</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Pay inside Telegram — {STARS_PRESETS.join('★, ')}★ presets or any custom amount. 1★ ≈ $0.014 of credits.
                </span>
              </li>
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Crypto — {CRYPTO.join(', ')}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Send from any wallet or exchange, submit the transaction hash, credits land after a quick
                  review. Minimum ticket $0.10.
                </span>
              </li>
            </ul>
          </Glass>
        </section>

        {/* Comparison */}
        <section className="mt-10">
          <Kicker>Why pay-as-you-use</Kicker>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Bot platforms typically rent you features: $10–$50 every month, per bot, whether you use
            them or not — and double-dip with per-message credits on top. Idle months still cost full
            price. NURAE inverts that: hosting is <span className="n-num text-foreground">$0.01</span> per bot
            per day, usage is priced at provider cost plus a sliver, and the free week plus daily
            allowances absorb most hobby bots entirely — a Plus plan exists for when your usage is real
            and you would rather prepay than watch meters. You only ever pay for work that actually
            happened — which is why we can undercut every flat-rate platform while running the same
            infrastructure.
          </p>
        </section>

        {/* FAQ */}
        <section className="mt-10">
          <Kicker>Questions</Kicker>
          <Glass bleed className="mt-3">
            <ul className="m-0 list-none divide-y divide-[color:var(--depth-line-soft)] p-0">
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">What happens when my balance hits zero?</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Free daily allowances keep working. Beyond them, bots pause (your users see silence, your
                  dashboard shows exactly which send was skipped) and resume the instant you top up. Nothing
                  is deleted, ever.
                </span>
              </li>
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Do the prices change?</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  They can be tuned, but the free week and free daily tiers are the product, not a promotion.
                </span>
              </li>
              <li className="px-4 py-3 text-sm">
                <span className="text-foreground">Stars or crypto — any difference?</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Stars credit instantly inside Telegram. Crypto needs one confirmation and a quick manual or
                  automatic check. Both land in the same wallet.
                </span>
              </li>
            </ul>
          </Glass>
        </section>

        <div className="mt-12">
          <Link
            href="/bots"
            className="inline-block rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted/30"
          >
            Build your first bot — free for {TRIAL_DAYS} days
          </Link>
        </div>
      </PageContainer>
      <SiteFooter siteName="NURAE" />
    </div>
  );
}
