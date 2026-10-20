# NURAE V4 Depth — Unification Report (2026-10-18)

Execution of the master blueprint in `agent-collab.md` §4 (Phases 1–6), with a build/test gate and a
CDP browser verification loop. Every claim below is backed by a command output, a file reference, or a
capture in `.zshots_v4/`.

## 1. What landed

| Phase | Files | What changed |
| --- | --- | --- |
| 1 | `src/components/nurae/depth.tsx`, `src/app/globals.css` | New `PageContainer({variant,kicker,title,description,actions,...})` scaffold (stagger, fluid gutters, standard header block); `DepthBackground` now takes `variant: 'dashboard' \| 'studio' \| 'marketing'`; two new aurora variants in CSS. |
| 2 | `pricing-page.tsx`, `help-page.tsx`, `about-page.tsx`, `featured-view.tsx` | Migrated to `PageContainer(marketing)`: 3 Glass plan tiers (Plus highlighted with a monochrome glow — the blueprint's emerald idea was dropped to keep the zero-chroma palette), Glass FAQ accordions, kickers on every section, Glass tables. All copy/data/routes unchanged. |
| 3 | `bot-detail-view.tsx` | Recomposed into the 3-pane studio: breadcrumb kicker (`Bots / [name]`), ARIA tab bar (Behavior / Preview / Ecosystem / Configuration / Advanced / Danger), panels kept mounted so form state survives, sticky right rail with real data only (status, wiring, provider/model, counts, temperature, tokens, memory, timestamps). |
| 4 | `console.tsx` | Depth shell, Kicker + title header, Glass login gate. `views.tsx` and `bot-view.tsx` are **blocked by the workspace write guard** — see §4. |
| 5 | `ui/dialog.tsx`, `ui/sheet.tsx`, `ui/popover.tsx`, `ui/dropdown-menu.tsx`, `ui/alert-dialog.tsx`, `ui/command.tsx` | Glass treatment (`#16171d/95`, `backdrop-blur-xl`, `white/10` hairline, 12px radius, 0 24px 60px depth shadow), quiet close buttons, overlay darkened. Radix APIs, exports, data-slots untouched. |
| 6 | `.zscripts/shoot.mjs` | Route matrix extended with `/bots/[id]` (id supplied via `SHOOT_BOT_ID`); 21 desktop/mobile captures + 2 anonymous landing captures. |

## 2. Verification (gate)

- **Build**: `npm run build` → exit 0, `Compiled successfully`, standalone bundle `2776 files / 220.2 MB`.
- **Tests**: `npm test` → **513 / 515 passing** (35 suites, 1 failing file).
  The 2 failures are `tests/nurae/email-invites.test.ts` ("invite queue (ticker job)" timeouts) and are
  **pre-existing**: the identical baseline run before any change produced the same 2 failures. No
  regression was introduced by this wave.
- **Type-level**: child agents ran `tsc --noEmit` per file batch; all reported zero new errors in
  touched files (pre-existing errors elsewhere unchanged). The production build is the final gate.

## 3. Verification (visual, browser)

21 authenticated/public captures in `.zshots_v4/` plus 2 anonymous in `.zshots_v4_anon/`, produced by
the repo's CDP pipeline (headless Chrome, real session cookie, intro bypass):

`dashboard · pricing · help · about · featured · bots · chats · agents · billing · bot-detail ·
admin-{dashboard,customers,bots,projects,settings,agent} · m-home · m-dashboard · m-admin-customers · home (anon) · m-home (anon)`

Inspected against the V4 spec (kickers, glass panels, metric strips, mono numerals, gutters):

- dashboard / bots / billing / chats — glass metric strips, tables, rings render as designed;
- pricing — kicker `BILLING & TIERS`, 3 Glass tiers, Glass price table, Glass FAQ;
- help — `HELP CENTER` kicker, Glass accordion FAQ, Glass CTA card;
- bot-detail — `BOTS / SUPPORT BOT` breadcrumb, tab bar, behavior list in Glass, telemetry rail populated
  from real bot data (10 behaviors, 0 commands, 10 replies, temp 0.7, 1024 tokens, memory 10);
- anonymous `/` — hero + Glass AuthCard + feature band (the logged-in run redirects `/` to `/dashboard`,
  hence the separate anon capture);
- admin routes show the restyled Glass token gate (no admin token configured in this environment).

**Verify loop outcome**: no V4 mismatches were found, so no fix-and-reverify iteration was required.
Two artifacts were investigated and attributed:

1. **Serif body fallback** on some prose paragraphs in headless captures — proven pre-existing: the
   Oct 17 20:34 capture (`.zshots_test/dashboard.png`) shows the identical fallback on the same
   paragraphs. Environment quirk of the capture browser, not a regression.
2. **Flat black band** below ~900px in full-page captures — the fixed aurora only paints the viewport;
   inherent to `captureBeyondViewport`. Not a live scrolling behavior.

Browser-tool note: the AutoClaw browser pane refuses `localhost` (private-target policy), so the CDP
headless-Chrome pipeline — the repo's own prescribed verification instrument — was used for all
visual checks.

## 4. Known gaps / follow-ups

1. **`views.tsx` + `bot-view.tsx` not restyled.** The workspace write guard denies every write to these
   files: two pre-existing lines read like credential assignments (a `needsToken` boolean and the
   credentials-status readout in the config card). Both are false positives — status displays, no real
   secrets — but guard policy leaves the decision to the owner. Smallest fix if approved: rename
   `needsToken` → `needsSetup` and reword the readout (em-dash form), then apply the depth pass
   (StatusBar with real counts, Glass list wrappers, `white/[0.04]` row hovers, kickers) and re-run the
   gate + admin captures.
2. **Admin inner views unverified visually** — captures stop at the token gate because no admin token
   exists in this environment. Once an admin token is set, re-shoot `/admin/*` for the inner tables.
3. **Serif fallback** (pre-existing): if desired, pin an explicit fallback stack next to the Geist
   variables so captures and unusual environments degrade to system sans instead of serif.

## 5. Environment facts learned

- `LOCALAPPDATA` is **unset** in this shell, so the app data home resolves through the
  `paths.ts` homedir fallback to `C:\Users\user\AppData\Local\FRAZIYM\NURAE` (the documented
  `%LOCALAPPDATA%\FRAZIYM\NURAE` does not exist here). The dev DB used for verification was created
  fresh there.
- Seeding used only app-native endpoints: register → (verification code is stored hashed, and no mailer
  is configured, so `email_verified` was set for the throwaway account in the local dev DB) → sign-in →
  bot from template `support-faq`. Scratch helpers left at `.zscripts/dbprobe.py`, `dbcols.py`,
  `dbverify.py` (not part of the product).
- `shoot.mjs` with `SHOOT_SERVER=1` owns the server lifecycle; without it, point it at an already
  running base URL. A session cookie makes `/` redirect to `/dashboard` — use a cookie-less run for the
  landing page.

## 6. Re-run verification

```powershell
cd NURAE
npm run build
npm test
$env:PORT='3000'; node scripts/start-prod.mjs        # or SHOOT_SERVER=1 inside the shoot call
$env:TEST_SESS='<session cookie value>'
$env:SHOOT_BOT_ID='<real bot id>'
node .zscripts\shoot.mjs http://127.0.0.1:3000 .zshots_v4            # authenticated matrix
node .zscripts\shoot.mjs http://127.0.0.1:3000 .zshots_v4_anon home  # anonymous landing
```
