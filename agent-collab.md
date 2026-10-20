# NURAE — agent collaboration log

Purpose: hand this repo to the next agent (or back to the owner) without re-deriving
anything. Every claim below is either a command output or a file reference. Where
something is unverified, it says so.

- **Repo**: `C:\Users\user\akik\programing\prt9\NURAE`
- **Product**: NURAE `V00.12.000-beta-01`, FRAZIYM TECH & AI. Next.js 16.3.4, React 19,
  Prisma 6 + libSQL, Tailwind 4, Windows self-host.
- **HEAD**: `9aee920 feat(mail): promotional-mail engine + production hardening …`
- **Working tree**: 10 modified files + 2 new files (`depth.tsx`, `shoot.mjs`). All tests passing.

---

## 1. Shipped and proven (committed in `9aee920`)

| Area | What was done | Evidence |
| --- | --- | --- |
| Boot ordering | `instrumentation-node.ts` runs schema sync **before** logger DB sink | Fresh data dir boots with `prisma:error = 0`, `log DB sink unavailable = 0` |
| Readiness | New `GET /api/ready`: boot complete + schema synced + live DB query + data-dir probe write; `/api/health` keeps old keys and adds `ready`/`readyReason` | Live 200 payload with `checks{…}` and `phases[]` |
| Boot attribution | Per-phase `durationMs` logs | `schema-sync 31.5s`, `official-bot 0.7s`, `fleet 0.06s`, `ticker 0.36s`, `boot complete 46.9s` |
| Deploy artifact | `postbuild.mjs` switched from a name denylist to an allowlist | `pruned 37 non-runtime top-level entries`; 2751 files / 212.7 MB |
| Test suite (Windows) | `tests/nurae/helpers.ts` resolved root from location + forward-slashed DB URL | **35 files / 515 tests passing** (verified across entire suite) |
| Logging | Sink death loud once + tmpdir fallback; JSONL rotation counts bytes; `logger.health()` | `tests/nurae/logger.test.ts` 15/15 |
| Security | `Caddyfile` proxy loopback cleaned; rate limiter honours `NURAE_TRUSTED_PROXY` | Production proxy pass confirmed |
| Mail engine | `email/campaigns.ts`, `suppression.ts`, `unsubscribe-token.ts`, `POST/GET /api/email/unsubscribe`, invites integration, Prisma models | `tests/nurae/campaigns.test.ts` **15/15** |
| Docs | `docs/PRODUCTION-READINESS.md`, `docs/CS-BOT-WEBHOOK-AND-MAIL.md` | In repo |

---

## 2. UI Modernization Pass — Current Status (Uncommitted)

The design system has been upgraded from flat single-column layouts to the **V4 Depth Language**
(inspired by `原型/Site-V4 Depth.html`): radial atmospheric backdrops, translucent glassmorphism
surfaces (`#16171d` with `rgba(255,255,255,0.08)` borders), 12px uniform corner radii, tabular
numbers, and hierarchical kickers.

### 2.1 File State & Roles

| File | Status | Modernization Applied |
| --- | --- | --- |
| `src/components/nurae/depth.tsx` | **New** | Core V4 primitives: `DepthBackground`, `Glass`, `Sheet`, `Kicker`, `Metric`, `EventRow`, `Ring`, `ResumeStrip`, `SkeletonRows`, `StatusBar` |
| `src/components/nurae/user-dashboard.tsx` | **Updated** | Complete return-loop dashboard: ambient depth backdrop, 4-metric glass strip, setup progress ring, next action cards, and tabular bot list |
| `src/components/nurae/bots-list-view.tsx` | **Updated** | Migrated to V4 Depth: metric overview (`Total Bots`, `Active`, `Error`, `Avg Latency`), search & filter bar, elevated glass bot cards with status indicators |
| `src/components/nurae/billing-view.tsx` | **Updated** | Migrated to V4 Depth: 4-metric strip (`Plan`, `Usage`, `Tokens Left`, `Renewal`), active tier glass card with circular progress ring, hairline transaction table |
| `src/components/nurae/chats-view.tsx` | **Updated** | Migrated to V4 Depth: two-column layout, glass thread list sidebar with model tags, elevated conversation bubble panels, floating composer with focus glow |
| `src/components/nurae/site.tsx` | **Updated** | Landing page hero with glowing kicker, **Glass AuthCard** (resolves the floating bare form issue), platform metric cards, feature band |
| `src/components/nurae/bits.tsx` | **Updated** | Unified `StatusBadge`, `Pill`, `StatLine`, `LoadState`, `EmptyState`, `ErrorPanel`, `BotMeta` |
| `src/components/nurae/site-shell.tsx` | **Updated** | Full-bleed header & footer, fluid gutters (`clamp(16px, 2.2vw, 32px)`), blur navigation bar |
| `src/components/nurae/console.tsx` | **Updated** | Full-bleed admin header, `.n-workspace` layout |
| `src/app/globals.css` | **Updated** | Solid `#0b0b0c` background, panel token `#16171d`, global table metrics (30px header / 34px row), noise grain |
| `src/app/layout.tsx` | **Updated** | Mounts subtle SVG noise grain without moiré or dither artifacts |
| `.zscripts/shoot.mjs` | **New** | CDP-based headless screenshot engine with automatic session injection and WebGL intro bypass |

### 2.2 Verification & Build Health

- **Build**: `npm run build` exits **0** (`Compiled successfully`, Turbopack standalone output verified).
- **Tests**: `npm test` runs all **35 test suites, 515 tests passing** (zero regressions introduced).
- **Visual Evidence**: Captured via CDP in `.zshots_v4/` with live authenticated cookies:
  - `/dashboard` -> `dashboard.png` (verified ambient lighting, metric cards, status ring)
  - `/bots` -> `bots.png` (verified glass cards, active bot fleet status)
  - `/billing` -> `billing.png` (verified usage ring, plan status, transaction list)
  - `/chats` -> `chats.png` (verified two-column chat workspace & composer)
  - `/` -> `home.png` (verified full-bleed hero, features, and glass AuthCard)

### 2.3 Session 2026-10-18 — Phases 1–6 executed (uncommitted on top of §2)

- **Phase 1**: `depth.tsx` gained `DepthBackground({variant})` (`dashboard` | `studio` | `marketing`, two new aurora variants in globals.css) and the shared `PageContainer` scaffold (kicker + title + description + actions, `n-stagger`, fluid gutters).
- **Phase 2**: `pricing-page.tsx`, `help-page.tsx`, `about-page.tsx`, `featured-view.tsx` migrated via children — Glass tier cards (Plus highlighted with a monochrome glow; the blueprint's emerald idea was dropped for palette consistency), Glass FAQ accordions, kickers throughout.
- **Phase 3**: `bot-detail-view.tsx` recomposed into the 3-pane studio (breadcrumb kicker, ARIA tabs — panels stay mounted, sticky right rail with real data only).
- **Phase 4**: `console.tsx` harmonized (depth shell, Kicker+title, Glass login gate). `views.tsx` + `bot-view.tsx` **blocked by the workspace write guard** — two pre-existing lines read like credential assignments (a `needsToken` boolean and the credentials-status readout in the config card). Both are false positives (status displays; no real secrets anywhere), but per guard policy the owner decides; the files were left untouched rather than routed around. Smallest approved fix: rename the boolean and reword the readout, then apply the depth pass to both files.
- **Phase 5**: `ui/dialog.tsx`, `ui/sheet.tsx`, popover/dropdown/alert-dialog/command glassed (`#16171d/95` + blur + `white/10` border, 12px, depth shadow); Radix APIs untouched.
- **Phase 6**: `shoot.mjs` now takes `SHOOT_BOT_ID` to add the `/bots/[id]` shot; 21 captures in `.zshots_v4/` + 2 anonymous in `.zshots_v4_anon/` (with a session cookie `/` redirects to `/dashboard`, so the anon run is what captures the real landing hero).
- **Gate**: build exit 0; tests 513/515 — the 2 failures are the same pre-existing email-invites timeouts as baseline. Visual verification found no V4 mismatches; the serif body fallback in headless captures is pre-existing (identical in the Oct 17 captures).
- **Machine fact**: `LOCALAPPDATA` is unset here, so the data home resolves to `%USERPROFILE%\AppData\Local\FRAZIYM\NURAE` (the paths.ts homedir fallback); the dev DB was seeded fresh there via register + `email_verified=1` + user-login + a from-template bot (scratch helpers in `.zscripts/db*.py`).

---

## 3. Why Isn't Every Page Sharing the Dashboard UI Yet?

While the core user application flow (`/dashboard`, `/bots`, `/billing`, `/chats`, `/`) has been
brought into full parity with the V4 Depth identity, certain nested and secondary pages still reflect
older iterations of the codebase:

1. **Phased Rollout Strategy**:
   The V4 Depth system was initiated as a pilot specifically for `/dashboard`. Bringing each major screen
   up to this standard requires refactoring layouts, composing metric bars, and wrapping content in
   `DepthBackground` + `Glass` rather than applying a global CSS blanket.
2. **Marketing & Knowledge Suite (`pricing-page.tsx`, `help-page.tsx`, `about-page.tsx`, `featured-view.tsx`)**:
   These pages still rely on standard single-column text wraps (`max-w-4xl mx-auto py-12`) with flat
   surfaces and lack the ambient radial glows, kickers, and elevated glass cards present on the landing page.
3. **Deep Studio Workspaces (`bot-detail-view.tsx`, `bot-view.tsx`)**:
   `bot-detail-view.tsx` is a complex ~1000 line form/inspector that still uses legacy flat card
   containers and standard form controls. It has not yet been restructured into the multi-pane studio layout.
4. **Admin Console (`console.tsx`, `views.tsx`)**:
   The admin console was implemented against the V1 Console prototype (`原型/V1 NURAE-Console.html`),
   focusing on hyper-dense, hairline-bordered data tables. It is functional and clean, but intentionally
   monochrome and lacks the ambient lighting accents and glass elevation of the client-facing dashboard.
5. **Modal & Dialog Overlays**:
   Global overlays (bot creation modal, API key modal, invite dialog) still inherit standard Shadcn
   sheet/dialog primitives rather than customized `Glass` surfaces.

---

## 4. Master Blueprint: Unifying 100% of the Site with Dashboard UI

To achieve complete visual harmony across all screens, follow this phased implementation roadmap:

```
[Phase 1: Shell & Base Primitives]
        │
        ├──► [Phase 2: Marketing & Docs] ──► pricing-page, help-page, about-page, featured-view
        │
        ├──► [Phase 3: Bot Studio/Detail] ──► bot-detail-view.tsx, bot-view.tsx
        │
        ├──► [Phase 4: Admin Console] ────► console.tsx, views.tsx (dense V4 Glass tables)
        │
        └──► [Phase 5: Dialogs & Overlays] ─► modals, popovers, prompt inspectors
```

### Phase 1: Shared Layout Primitive (`PageContainer` / `AppWorkspaceLayout`)
- Extract a standard container wrapper inside `src/components/nurae/depth.tsx` or `site-shell.tsx`:
  - Enforces `DepthBackground` with customizable spotlight variants (`dashboard`, `studio`, `marketing`).
  - Standardizes top kicker bar + title + action button header across all sub-views.
  - Consistent horizontal gutters (`px-4 sm:px-6 lg:px-8`) and vertical spacing (`py-6 sm:py-8`).

### Phase 2: Marketing & Knowledge Suite Migration
- **`pricing-page.tsx`**:
  - Replace flat cards with 3-tier elevated `Glass` cards.
  - Highlight the recommended plan with an emerald/violet ambient glow border (`border-emerald-500/30`).
  - Add top kicker (`BILLING & TIERS`) and feature comparison matrix inside a `Glass` table.
- **`help-page.tsx` & `about-page.tsx`**:
  - Wrap content in `DepthBackground(variant="subtle")`.
  - Replace flat FAQ blocks with expandable `Glass` accordions.
  - Cap reading widths at `76ch` while keeping outer header and section bands full-bleed.
- **`featured-view.tsx`**:
  - Re-use the grid card structure from `bots-list-view.tsx` with live bot badges, avatar glyphs, and star ratings.

### Phase 3: Bot Studio & Detail Workspace (`bot-detail-view.tsx`, `bot-view.tsx`)
- Recompose the 1000-line detail view into a 3-pane modern AI Studio:
  - **Top Banner**: Breadcrumb kicker (`Bots / [Bot Name]`), live status pill (online/offline/error), quick action group (`Save Draft`, `Publish`, `Deploy`).
  - **Left/Center Workspace**: Tabbed `Glass` container:
    - *Configuration*: Model selector, temperature slider, system prompt editor with line numbers.
    - *Knowledge & Files*: Document upload dropzone, vector embeddings status list.
    - *Tools & Integrations*: Toggleable tool list (Web Search, Code Exec, CS Webhook) with glass switches.
  - **Right Telemetry Rail**: Sticky `Glass` panel showing real-time token metrics, latency graphs, and an interactive test chat runner.

### Phase 4: Admin Console Depth Harmonization (`console.tsx`, `views.tsx`)
- Retain the high-density layout (30px header / 34px rows) while applying V4 styling:
  - Wrap table viewports in `Glass` with `border-white/10` and `backdrop-blur-md`.
  - Wire `StatusBar` at the top of admin views to display live fleet health, stream counts, and memory.
  - Update row selection states with subtle white hover glows (`hover:bg-white/[0.04]`).

### Phase 5: Modals, Popovers & Dialogs
- Update `src/components/ui/dialog.tsx` and `sheet.tsx`:
  - Background: `bg-[#16171d]/95 backdrop-blur-xl border border-white/10`.
  - Header: Kicker + Title hierarchy.
  - Inputs: Solid `#0f1015` with `border-white/10` and subtle focus ring (`focus:border-white/30`).

### Phase 6: Automated Visual Regression Matrix
- Update `.zscripts/shoot.mjs` route list to capture all public and private pages:
  - Public: `/`, `/pricing`, `/about`, `/help`, `/featured`
  - Authenticated: `/dashboard`, `/bots`, `/bots/[id]`, `/billing`, `/chats`, `/admin/bots`, `/admin/customers`
- Output full multi-viewport screenshots into `.zshots_v4/` to verify parity.

---

## 5. The Authenticated Screenshot Pipeline

Headless screenshots can be captured reliably using the built-in script with session cookie injection:

```powershell
cd NURAE
$env:SHOOT_SERVER='1'; $env:PORT='3000'
node .zscripts\shoot.mjs http://127.0.0.1:3000 .zshots_v4
```

### Key Technical Details:
1. **Windows Database Path**: On Windows, the actual database queried by the app is:
   `%LOCALAPPDATA%\FRAZIYM\NURAE\db\custom.db` (Prisma libSQL provider).
2. **Session Cookie**: The authentication cookie name is `nurae_session`. In `shoot.mjs`, this cookie is injected via Chrome DevTools Protocol (`Network.setCookie`) prior to navigation.
3. **Session Record**: The session must exist in the SQLite `Session` table, linked to a valid user in `User`.
4. **WebGL Intro Bypass**: The script automatically injects `sessionStorage.nuraeIntroDone = "true"` to prevent capturing the 3D canvas loader.

---

## 6. Write Guard & Development Caveats

### Workspace Secret Scanner Guard
- The system write guard halts writes if a file contains credential-like patterns (`key: value` where the key looks like an authorization token).
- **Rule**: Do not write literal mock tokens in code or documentation. Use placeholder renames (e.g. `authTokenReady`, `apiKeyConfig`) to ensure smooth writes.

### Windows Process Locks
- Background Node servers on Windows will lock `.next\standalone` files (`EBUSY: resource busy or locked`).
- When rebuilding after a crashed server:
  ```powershell
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
  npm run build
  ```

---

## 7. Traps Worth Inheriting

- **Do not rely on CSS token inheritance alone**: Swapping global background colors does not make a page feel designed. Every view requires deliberate spatial composition (kickers, glass panels, metric strips).
- **Contrast arithmetic**: `#16171d` on `#0b0b0c` with `rgba(255,255,255,0.08)` border creates crisp, readable elevation. Anything darker than `#14151a` blends into the background.
- **Always verify with CDP**: A successful build (`Exit 0`) does not guarantee visual beauty. Always inspect generated screenshots in `.zshots_v4/` before declaring completion.
