'use client';

/**
 * NURAE — /pricing: pay-as-you-use by default, optional plans on top.
 * Plans are additive perks bought from the wallet — the free tier never
 * shrinks. The table reads the compiled catalog so code and copy cannot
 * drift; the plan cards mirror billing/plans.ts.
 */

import Link from 'next/link';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { DEFAULT_CATALOG, MICRO, STARS_PRESETS, TRIAL_DAYS } from '@/lib/nurae/billing/catalog';
import { PLANS } from '@/lib/nurae/billing/plan-catalog';

const usd = (micros: number): string => {
  const out = (Math.abs(micros) / MICRO).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${micros < 0 ? '-' : ''}$${micros === 0 ? '0' : out}`;
};

const CRYPTO = ['TON (Gram)', 'BTC', 'USDT', 'ETH', 'LTC', 'TRX'];

export function PricingPage() {
  const { user, checked, signOut } = useSiteUser();

  if (!checked) return <SiteSplash />;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader variant={user ? 'app' : 'public'} user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Pricing</p>
        <h1 className="mt-2 text-2xl font-medium tracking-tight text-foreground">Pay as you use — or boost it with a plan</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Every feature has a per-unit price in the fractions of a cent, every account gets{' '}
          {TRIAL_DAYS} free days (the free server week), and every feature keeps a free daily
          allowance even after that. You top up when — and only when — your bots actually earn or
          need it. Want bigger allowances and hosting included? A plan does that; nothing else
          changes.
        </p>

        {/* Plans */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Plans (optional, paid from your wallet)</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div key={plan.id} className="rounded-lg border border-border/60 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{plan.name}</span>
                  <span className="font-mono text-sm text-foreground">
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
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Plans never gate features — they make the numbers bigger. <Link href="/billing" className="underline">Billing → Your plan</Link> activates in one click from your wallet balance; same-plan renewals stack, so renewing early never costs you days.
          </p>
        </section>

        {/* Free week + free tier */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Free, on every account</p>
          <ul className="mt-3 border-t border-border/60">
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">{TRIAL_DAYS}-day free server week</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                From the moment you sign up: hosting, AI, messages — everything free for a week. No card, no wallet needed.
              </span>
            </li>
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Free daily allowances, forever</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Each feature below includes a free quota every UTC day. Small bots often never leave the free tier.
              </span>
            </li>
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Premium days via invites</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Every friend who signs up with your invite link and verifies their email adds premium days —
                all usage free while they last. <Link href="/billing" className="underline">Billing → invite</Link>.
              </span>
            </li>
          </ul>
        </section>

        {/* Price table */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Prices</p>
          <ul className="mt-3 border-t border-border/60">
            {DEFAULT_CATALOG.map((f) => (
              <li key={f.key} className="border-b border-border/60 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="text-foreground">{f.displayName}</span>
                  <span className="font-mono tabular-nums text-foreground">{usd(f.unitPriceMicros)}</span>
                  <span className="text-xs text-muted-foreground">/ {f.unit}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {f.freeDailyUnits > 0 ? `${f.freeDailyUnits} free / day` : 'pay per use'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            To put that in perspective: $1 of credits covers about 20,000 bot messages, or ~666 AI
            replies, or 100 days of hosting one bot. Bring your own AI provider key and bot AI replies
            cost you nothing at all.
          </p>
        </section>

        {/* Payment methods */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Top-up methods</p>
          <ul className="mt-3 border-t border-border/60">
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Telegram Stars</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Pay inside Telegram — {STARS_PRESETS.join('★, ')}★ presets or any custom amount. 1★ ≈ $0.014 of credits.
              </span>
            </li>
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Crypto — {CRYPTO.join(', ')}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Send from any wallet or exchange, submit the transaction hash, credits land after a quick
                review. Minimum ticket $0.10.
              </span>
            </li>
          </ul>
        </section>

        {/* Comparison */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Why still cheaper than the other guys</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Bot platforms typically rent you features: $10–$50 every month, per bot, whether you use
            them or not — and double-dip with per-message credits on top. Idle months still cost full
            price. NURAE inverts that: hosting is <span className="font-mono text-foreground">$0.01</span> per bot
            per day, usage is priced at provider cost plus a sliver, and the free week plus daily
            allowances absorb most hobby bots entirely — a Plus plan exists for when your usage is real
            and you would rather prepay than watch meters. You only ever pay for work that actually
            happened — which is why we can undercut every flat-rate platform while running the same
            infrastructure.
          </p>
        </section>

        {/* FAQ */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Questions</p>
          <ul className="mt-3 border-t border-border/60">
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">What happens when my balance hits zero?</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Free daily allowances keep working. Beyond them, bots pause (your users see silence, your
                dashboard shows exactly which send was skipped) and resume the instant you top up. Nothing
                is deleted, ever.
              </span>
            </li>
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Do the prices change?</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                They can be tuned, but the free week and free daily tiers are the product, not a promotion.
              </span>
            </li>
            <li className="border-b border-border/60 py-3 text-sm">
              <span className="text-foreground">Stars or crypto — any difference?</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Stars credit instantly inside Telegram. Crypto needs one confirmation and a quick manual or
                automatic check. Both land in the same wallet.
              </span>
            </li>
          </ul>
        </section>

        <div className="mt-12">
          <Link
            href="/bots"
            className="inline-block rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted/30"
          >
            Build your first bot — free for {TRIAL_DAYS} days
          </Link>
        </div>
      </main>
      <SiteFooter siteName="NURAE" />
    </div>
  );
}
