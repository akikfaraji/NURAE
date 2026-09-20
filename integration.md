# NURAE LOADER — Integration Guide

**v2 — orbital system** (restored by user preference, V00.12.000-beta-01; the
v3 "Reality is being resolved" redesign was reverted — its only legacy is the
smoothing pass documented in §7)

The NURAE loading experience is a real-time WebGL cinematic that plays at the
root of the site as a one-time-per-session intro, and doubles as a continuous
seamless-loop loading screen. This document is the public contract: engine API,
component props, URL params, CSS classes, timing data and verification hooks.

---

## 1. Concept (one paragraph)

A single luminous point opens into a deep-space orbital system: ~24 constant-
width glowing ribbon rings in four families slide in one wave at a time with
travelling arc clusters, comet heads and node dots; SDF ripples breathe outward
with angular hotspots; a fine wireframe sphere and an 850-point dust field give
the mesh depth. The camera dollies through five framings (reveal → lean into
the eye → dive into collapse → whip back out → idle drift) so the sequence
reads as a progression, never a repeating cycle. The eye opens (iris + dark
pupil), the whole system collapses into it, a light flash births it back, and
the NURAE wordmark settles under an ambient READY hold before the seamless
loop seam eases everything to black and around again.

---

## 2. Files

| File | Role |
|---|---|
| `src/lib/nurae/phases.ts` | 8-phase storyboard table (PHASES), easing helpers (`sm`, `bell`, `pulse`, `easeOutCubic`, `easeInOutCubic`, …), key moments `T` |
| `src/lib/nurae/shaders.ts` | GLSL: `QUAD_VERT`, `RING_VERT/RING_FRAG` (ribbon rings), `RIPPLE_FRAG`, `IRIS_FRAG`, `PUPIL_FRAG`, `BEAM_FRAG`, `NEBULA_FRAG` |
| `src/lib/nurae/textures.ts` | canvas-generated sprite textures (`makeGlowTexture`, `makeFlareTexture`) |
| `src/lib/nurae/engine.ts` | `NuraeEngine` — scene build + real-time update loop + bloom composer |
| `src/components/nurae/NuraeExperience.tsx` | React wrapper: canvas, HUD (corners, phase dots), wordmark, loading bar, flash layer |
| `src/components/nurae/intro-overlay.tsx` | Boot layer: `ssr:false` dynamic mount, session gating, fade + handoff, reduced-motion skip |
| `src/app/layout.tsx` | `NURAE_BOOT_SCRIPT` (pre-paint attribute) + `<NuraeIntroOverlay/>` at root |
| `src/app/globals.css` | `.nurae-boot-layer`, boot hiding rules, `.nurae-vignette`, `.nurae-grain`, `.nurae-loading`, `.nurae-dash`, `.nurae-track[data-ready]`, `nurae-site-reveal` |

---

## 3. Engine API

```ts
import { NuraeEngine, LOOP_END } from '@/lib/nurae/engine'

const engine = new NuraeEngine(canvas, {
  onPhase: (index: number) => {},          // fired when the phase index changes
  onTick: (s: TickState) => {},            // every frame, after render
})
engine.start()     // builds the GL context, starts rAF; idempotent
engine.restart()   // seek(0)
engine.seek(t)     // exact storyboard time — re-derives ripple field, deterministic
engine.dispose()   // cancels rAF, disposes geometries/materials/textures/renderer
```

- `LOOP_END = 12.0` — storyboard is 7.4s, READY hold runs to 11.35s, the master
  fade seam (11.35 → 11.92s) eases everything to black and phase 01 fades back
  in over the first 0.55s. Live wrap is state-identical.
- `TickState = { t, flash, readyW, progress, fade }` — `flash` drives the DOM
  flash layer, `progress` the loading-bar dash (0→1 over 8.2s), `fade` rides
  the seam (the wordmark multiplies into it).
- Throwing in the constructor (no WebGL) is expected and MUST be treated as
  "complete the intro immediately" — never trap the user behind the loader.

## 4. Component props (Option A — one-time intro)

```tsx
<NuraeExperience />                    // standalone: continuous 12s loop, R restarts
<NuraeExperience playOnce onComplete={fn} />
```

`playOnce` fires `onComplete` once, ~1.2s after the READY wordmark reveal
begins (phase index 7). Keyboard `R` restarts in both modes; `onComplete` is
idempotent (guarded) and loop-wrap resets READY state safely.

## 5. Boot sequence (site integration)

1. Pre-paint, `NURAE_BOOT_SCRIPT` in `<head>` sets `data-nurae-intro` on
   `<html>`: `done` if `sessionStorage.nuraeIntroDone === '1'`, else `pending`.
   A 15s failsafe force-reveals the site if hydration ever fails.
2. `pending` → CSS hides `body > :not(.nurae-boot-layer)` (visibility) and
   paints `#010208` — no flash of site under the loader. Overscroll suppressed.
3. `<NuraeIntroOverlay/>` mounts at the root layout. After hydration it reads
   the attribute; `done` → never renders. `pending` → mounts the experience.
4. On complete: `sessionStorage.nuraeIntroDone = '1'`, attribute → `done`,
   `body.nurae-revealed` added → the site-reveal crossfade runs while the
   700ms overlay fade plays, then the layer unmounts (engine disposed).

## 6. URL params & debug hooks

- `?static` — explicit opt-in hold: ambient drift inside the READY window
  (t = 9.2 + (dt mod 2.1)), never a replay. Deliberately NOT tied to
  prefers-reduced-motion (many Android phones report it permanently; a frozen
  frame reads as a stuck loader — the overlay skips the intro instead, §7).
- `window.__nuraeT` (live t), `__nuraeSeek(t)`, `__nuraeRestart()`,
  `__nuraeFreeze = true` (pause time), `__nuraeComposer` (bloom tweaks),
  `__nuraeStarted` (mount counter) — verification hooks.

## 7. Smoothing pass (V00.12 — what changed vs the original v2)

Look is untouched; only temporal quality was upgraded:

- **Flash shaping** — collapse flash (t≈6.78) and eye flash (t≈4.32) now use
  `pulse(t, at, attack, release)` (fast attack, ~0.24–0.34s eased release)
  instead of symmetric 50ms bells that rendered 2-3 partial frames and popped.
- **Beam grow eased** — `uGrow` was a linear `clamp01` ramp inside a
  smoothstepped world; now `sm(t, 0.62, 1.37)`.
- **Seam fade eased** — the loop fade-in is a shared `seamFade()` helper with
  `easeInOutCubic` over 0.55s, used identically by `update()` and `loop()`.
- **Site-reveal crossfade** — on handoff the site itself fades in (0.9s,
  `cubic-bezier(0.22,1,0.36,1)`, opacity-only) under the overlay's 700ms
  fade — a real crossfade instead of a visibility flip. Opacity only: a
  transform would re-parent `position:fixed` descendants while animating.
- **Reduced-motion skip** — `prefers-reduced-motion: reduce` users skip the
  intro entirely (instant site, no canvas, no fade); the flag is still set so
  the rest of the session is identical.

## 8. Verification notes

- `playOnce` + seek: seeking to `t >= 7.4` fires the one-time handoff —
  neutralise the 1.2s handoff timer (or stub `onComplete`) when freezing
  frames for captures.
- Deterministic captures: set `window.__nuraeFreeze = true`, then
  `__nuraeSeek(t)`; ripple field, weights and camera are pure functions of t.
- Seam check: pixel-compare `seek(2.0)` vs `seek(14.0)` — expect near-identical
  frames modulo additive noise textures.
- Failure paths: WebGL ctor throw → immediate completion; 15s failsafe →
  force-reveal; both must leave the site fully interactive.
