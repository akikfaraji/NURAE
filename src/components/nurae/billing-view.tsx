'use client';

/**
 * NURAE — /billing: the pay-as-you-use wallet.
 *
 *   Balance + free week / premium status
 *   Top up — Telegram Stars (invoice link) or crypto (address + tx hash)
 *   Today's usage per feature against the free daily allowances
 *   The price book
 *   The ledger — every metered event, free or charged
 *
 * Typographic rows, no cards — consistent with the rest of the dashboard.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import {
  ApiError,
  BillingSummary,
  LedgerEntryDTO,
  TopupOrderDTO,
  nuraeApi,
} from '@/lib/nurae-client/api';
import { formatUsd } from '@/lib/nurae/billing/catalog';
import { PageFade } from '@/components/nurae/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MICRO = 1_000_000;

const usd = formatUsd;

function featureLabel(summary: BillingSummary | null, feature: string | null): string {
  if (!feature) return '—';
  return summary?.prices.find((p) => p.feature === feature)?.displayName ?? feature;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for payment',
  awaiting_confirmation: 'Confirming transaction',
  paid: 'Paid',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function BillingView() {
  const { user, checked } = useSiteUser();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntryDTO[]>([]);
  const [orders, setOrders] = useState<TopupOrderDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeOrder, setActiveOrder] = useState<TopupOrderDTO | null>(null);
  const [txHash, setTxHash] = useState('');
  const [customStars, setCustomStars] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, l, o] = await Promise.all([
        nuraeApi.billingSummary(),
        nuraeApi.billingLedger(60),
        nuraeApi.billingOrders(),
      ]);
      setSummary(s);
      setLedger(l.entries);
      setOrders(o.orders);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load billing.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      await refresh();
    })();
  }, [user, refresh]);

  async function subscribe(planId: 'plus' | 'pro') {
    setBusy(true);
    setError(null);
    try {
      await nuraeApi.billingSubscribe(planId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not activate the plan.');
    } finally {
      setBusy(false);
    }
  }

  async function topupStars(stars: number) {
    setBusy(true);
    setError(null);
    // Popup opened SYNCHRONOUSLY inside the click gesture — window.open after
    // an await is treated as unsolicited by every modern browser.
    const popup = window.open('', '_blank');
    try {
      const { order } = await nuraeApi.billingTopupStars(stars);
      setActiveOrder(order);
      setOrders((prev) => [order, ...prev]);
      if (order.payUrl && popup) {
        popup.location.href = order.payUrl;
        popup.opener = null; // detach — the payment window owes us nothing
      } else if (popup) {
        popup.close();
      }
      // The balance must reflect the flow — refresh after every topup step.
      await refresh();
    } catch (err) {
      popup?.close();
      setError(err instanceof ApiError ? err.message : 'Could not create the topup.');
    } finally {
      setBusy(false);
    }
  }

  async function topupCrypto(asset: string) {
    // Default ticket: $2 of credits — adjustable later; keep the flow one click.
    setBusy(true);
    setError(null);
    try {
      const { order } = await nuraeApi.billingTopupCrypto(asset, 2_000_000);
      setActiveOrder(order);
      setOrders((prev) => [order, ...prev]);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the topup.');
    } finally {
      setBusy(false);
    }
  }

  async function submitTx() {
    if (!activeOrder || txHash.trim().length < 10) return;
    setBusy(true);
    setError(null);
    try {
      const { order } = await nuraeApi.billingTopupSubmitTx(activeOrder.id, txHash.trim());
      setActiveOrder(order);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? order : o)));
      setTxHash('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit the transaction.');
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return <SiteSplash />;

  if (!user) {
    return (
      <div className="min-h-svh bg-background">
        <SiteHeader user={null} />
        <main className="mx-auto max-w-3xl px-5 py-16">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Billing</p>
          <h1 className="mt-2 text-xl font-medium">Sign in to see your wallet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your balance, usage and topups live in your account. See <Link className="underline" href="/pricing">Pricing</Link> for how pay-as-you-use works.
          </p>
        </main>
      </div>
    );
  }

  const freeRide = summary?.freeRide;
  const trialDaysLeft =
    freeRide?.trialEndsAt != null
      ? Math.max(0, Math.ceil((new Date(freeRide.trialEndsAt).getTime() - Date.now()) / 86_400_000))
      : 0;

  return (
    <div className="min-h-svh bg-background">
      <SiteHeader user={user} />
      <main className="mx-auto max-w-3xl px-5 pb-24 pt-8">
        <PageFade>
        {/* --- Balance ------------------------------------------------- */}
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Billing — pay as you use</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-3xl font-medium tabular-nums">{summary ? usd(summary.balanceMicros) : '—'}</h1>
          {freeRide?.mode === 'trial' && (
            <span className="text-xs text-muted-foreground">
              Free week active — {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left, everything included
            </span>
          )}
          {freeRide?.mode === 'premium' && (
            <span className="text-xs text-muted-foreground">
              Premium active{freeRide.premiumEndsAt ? ` until ${new Date(freeRide.premiumEndsAt).toLocaleDateString()}` : ''} — everything included
            </span>
          )}
          {!freeRide?.mode && summary && (
            <span className="text-xs text-muted-foreground">
              Free daily allowances apply to every feature below
            </span>
          )}
        </div>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Pay per use by default — a message costs $0.00005, an AI reply $0.0015. Optional plans boost
          the free allowances and include hosting. Invite friends for premium days, or top up when the
          free allowances run out.
        </p>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        {/* --- Your plan ------------------------------------------------ */}
        {summary && (
          <section className="mt-8">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Your plan</p>
            <div className="mt-3 rounded-lg border border-border/60 p-4">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-sm font-medium">{summary.plan.active ? `${summary.plan.name} — active` : 'Free'}</span>
                {summary.plan.active && summary.plan.expiresAt && (
                  <span className="text-xs text-muted-foreground">
                    renews monthly · until {new Date(summary.plan.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {summary.plan.active
                  ? `Every free daily allowance ×${summary.plan.dailyMultiplier} · hosting included for ${summary.plan.includedHostingBots} running bots`
                  : 'Every feature has a free daily allowance. Plans multiply it (Plus ×3, Pro ×10) and include hosting.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(['plus', 'pro'] as const).map((id) => {
                  const price = id === 'plus' ? 4_990_000 : 19_990_000;
                  const current = summary.plan.active && summary.plan.id === id;
                  return (
                    <Button
                      key={id}
                      variant="outline"
                      size="sm"
                      disabled={busy || current}
                      onClick={() => void subscribe(id)}
                      className="h-8 border-border/60 text-xs"
                    >
                      {current ? `Current: ${id === 'plus' ? 'Plus' : 'Pro'}` : `${id === 'plus' ? 'Plus' : 'Pro'} — ${usd(price)}/mo from wallet`}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Paid from your wallet balance (Stars / crypto topups feed it). Same-plan renewals stack —
                you never lose days by renewing early.
              </p>
            </div>
          </section>
        )}

        {/* --- Top up --------------------------------------------------- */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Top up</p>

          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              Telegram Stars{summary && !summary.topup.starsAvailable ? ' — unavailable (the platform bot has no token yet)' : ''}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(summary?.topup.starsPresets ?? []).map((stars) => (
                <Button
                  key={stars}
                  variant="outline"
                  size="sm"
                  disabled={busy || !summary?.topup.starsAvailable}
                  onClick={() => void topupStars(stars)}
                  className="h-8 border-border/60 font-mono text-xs"
                >
                  {stars}★ ≈ {usd(stars * (summary?.topup.starsRateMicros ?? 14_000))}
                </Button>
              ))}
              {summary?.topup.starsAvailable && (
                <div>
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = Number(customStars);
                      if (Number.isFinite(n) && n >= 25) void topupStars(Math.round(n));
                    }}
                  >
                    <Input
                      value={customStars}
                      onChange={(e) => setCustomStars(e.target.value)}
                      placeholder="custom ★"
                      inputMode="numeric"
                      className="h-8 w-28 border-border/60 text-xs"
                      aria-label="Custom Stars amount"
                    />
                    <Button variant="outline" size="sm" disabled={busy} className="h-8 border-border/60 text-xs" type="submit">
                      Buy
                    </Button>
                  </form>
                  {/* Silent no-ops are dead ends — say why the form refuses. */}
                  {customStars.trim() !== '' && (!Number.isFinite(Number(customStars)) || Number(customStars) < 25) && (
                    <p className="mt-1 text-xs text-destructive" role="alert">
                      Minimum Stars top-up is 25.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5">
            <p className="text-xs text-muted-foreground">
              Crypto{summary?.topup.cryptoAuto ? ' — automatic invoicing active' : ' — send to the address, then submit the transaction hash'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(summary?.topup.assets ?? []).map((a) => (
                <Button
                  key={a.asset}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void topupCrypto(a.asset)}
                  className="h-8 border-border/60 text-xs"
                  title={`${a.name} · ${a.network}`}
                >
                  {a.asset}
                </Button>
              ))}
              {summary && summary.topup.assets.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Crypto top-ups aren&apos;t configured on this server yet. Stars still work.
                </p>
              )}
            </div>
          </div>

          {activeOrder && (
            <div className="mt-5 rounded-lg border border-border/60 p-4">
              <p className="text-xs font-medium">Order {activeOrder.orderNo}</p>
              {activeOrder.provider === 'stars' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {activeOrder.expectedStars}★ ≈ {usd(activeOrder.expectedUsdMicros ?? 0)} — pay in Telegram.{' '}
                  {activeOrder.payUrl && (
                    <a href={activeOrder.payUrl} target="_blank" rel="noopener noreferrer" className="underline text-foreground">
                      Open the invoice
                    </a>
                  )}{' '}
                  The balance credits automatically seconds after payment.
                </p>
              )}
              {activeOrder.provider === 'crypto' && activeOrder.address && (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Send {usd(activeOrder.expectedUsdMicros ?? 0)} or more in {activeOrder.asset}
                    {summary?.topup.assets.find((a) => a.asset === activeOrder.asset)
                      ? ` (${summary.topup.assets.find((a) => a.asset === activeOrder.asset)?.network})`
                      : ''}
                    , then submit the transaction hash. Reference:{' '}
                    <span className="font-mono">{activeOrder.orderNo}</span>
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-foreground">{activeOrder.address}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Input
                      value={txHash}
                      onChange={(e) => setTxHash(e.target.value)}
                      placeholder="transaction hash"
                      className="h-8 w-full max-w-md border-border/60 font-mono text-xs"
                    />
                    <Button size="sm" disabled={busy || txHash.trim().length < 10} onClick={() => void submitTx()} className="h-8 text-xs">
                      Submit
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Credited after a quick review (usually minutes). You can close this page — the order stays in your history.
                  </p>
                </>
              )}
              {activeOrder.provider === 'crypto' && !activeOrder.address && activeOrder.payUrl && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Pay with any supported asset —{' '}
                  <a href={activeOrder.payUrl} target="_blank" rel="noopener noreferrer" className="underline text-foreground">
                    open the invoice
                  </a>
                  . Credits land automatically when it is paid.
                </p>
              )}
            </div>
          )}

          {orders.some((o) => o.status === 'awaiting_confirmation' || (o.status === 'pending' && o.provider === 'crypto' && !o.payUrl)) && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Open orders</p>
              <ul className="mt-2 border-t border-border/60">
                {orders
                  .filter((o) => o.status === 'awaiting_confirmation' || (o.status === 'pending' && o.provider === 'crypto' && !o.payUrl))
                  .slice(0, 5)
                  .map((o) => (
                    <li key={o.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-2 text-xs">
                      <span className="font-mono">{o.orderNo}</span>
                      <span className="text-muted-foreground">{o.asset ?? 'Stars'} · {usd(o.expectedUsdMicros ?? 0)}</span>
                      <button
                        className="ml-auto text-foreground underline"
                        onClick={() => {
                          setActiveOrder(o);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        {STATUS_LABEL[o.status] ?? o.status}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>

        {/* --- Usage today ---------------------------------------------- */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Usage today (UTC)</p>
          {loaded && summary && (
            <ul className="mt-3 border-t border-border/60">
              {summary.usageToday.map((u) => (
                <li key={u.feature} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-2 text-xs">
                  <span className="text-foreground">{featureLabel(summary, u.feature)}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {u.used}
                    {u.freeDailyUnits > 0 ? ` / ${u.freeDailyUnits} free` : ''}
                  </span>
                  <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                    {u.chargedTodayMicros > 0 ? usd(u.chargedTodayMicros) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Price book ------------------------------------------------ */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Prices</p>
          {summary && (
            <ul className="mt-3 border-t border-border/60">
              {summary.prices.map((p) => (
                <li key={p.feature} className="border-b border-border/60 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                    <span className="text-foreground">{p.displayName}</span>
                    <span className="font-mono tabular-nums text-foreground">{usd(p.unitPriceMicros)}</span>
                    <span className="text-muted-foreground">/ {p.unit}</span>
                    <span className="ml-auto text-muted-foreground">
                      {p.freeDailyUnits > 0 ? `${p.freeDailyUnits} free daily` : 'no free tier'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Orders history -------------------------------------------- */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Topup history</p>
          {loaded && orders.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No topups yet.</p>}
          <ul className="mt-3 border-t border-border/60">
            {orders.slice(0, 10).map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-2 text-xs">
                <span className="font-mono">{o.orderNo}</span>
                <span className="text-muted-foreground">{o.provider === 'stars' ? `${o.expectedStars}★` : o.asset ?? 'crypto'}</span>
                <span className="font-mono tabular-nums text-muted-foreground">{usd(o.creditedMicros ?? o.expectedUsdMicros ?? 0)}</span>
                <span className="ml-auto text-muted-foreground">{STATUS_LABEL[o.status] ?? o.status}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* --- Ledger ----------------------------------------------------- */}
        <section className="mt-10">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Ledger</p>
          {loaded && ledger.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Nothing metered yet.</p>}
          <ul className="mt-3 max-h-96 overflow-y-auto border-t border-border/60">
            {ledger.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-2 text-xs">
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                <span className="text-foreground">{e.kind === 'usage' ? featureLabel(summary, e.feature) : e.kind}</span>
                {e.note && <span className="text-muted-foreground">{e.note}</span>}
                <span
                  className={
                    'ml-auto font-mono tabular-nums ' +
                    (e.amountMicros > 0 ? 'text-foreground' : e.amountMicros < 0 ? 'text-muted-foreground' : 'text-muted-foreground/60')
                  }
                >
                  {e.amountMicros > 0 ? '+' : ''}
                  {e.amountMicros === 0 ? '0' : usd(e.amountMicros)}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground/70">→ {usd(e.balanceAfter)}</span>
              </li>
            ))}
          </ul>
        </section>
        </PageFade>
      </main>
    </div>
  );
}
