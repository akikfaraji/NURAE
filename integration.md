# NURAE LOADER — Integration Guide

**v3 — "Reality is being resolved"** (rewritten in the GOAT redesign round, V00.11.000-beta-01)

The NURAE loading experience is a real-time WebGL cinematic that plays at the
root of the site as a one-time-per-session intro, and doubles as a continuous
seamless-loop loading screen. This document is the public contract: engine API,
component props, URL params, CSS classes, timing data and verification hooks.

---

## 1. Concept (one paragraph)

A fixed vertical measurement axis — hairline plus ruler ticks — stands still in
an infinite dark field while fine restless marks drift at five parallax depths
around it (PERCEPTION). The marks stream outward past the viewer and accelerate,
yet the central point never grows: infinite distance without a single camera
zoom (INFINITE APPROACH). One thin measurement wave sweeps out from the axis and
every mark snaps onto a precise polar lattice of rings and spokes — the chaos
was information (RESOLUTION). The instrument dives into the axis; the axis
contracts to the surviving point (COLLAPSE); the point becomes the NURAE
wordmark (IDENTITY). Micro-saccades — tiny instantaneous re-fixations of the
whole field that die out at RESOLUTION — give the system a gaze.

Six beats: `VOID → PERCEPTION → INFINITE APPROACH → RESOLUTION → COLLAPSE → NURAE`.
Loop length `LOOP_END = 12.0s`, master fade seam `11.35s–11.92s` — seamless.

## 2. Files

| File | Role |
|---|---|
| `src/lib/nurae/phases.ts` | six-beat timeline (`PHASES`), key moments (`T`), easing helpers. **Internal timing data only — never render phase names in the UI.** |
| `src/lib/nurae/shaders.ts` | all GLSL (`FIELD_FRAG`, `AXIS_FRAG`, `SWEEP_FRAG`, `QUAD_VERT`) |
| `src/lib/nurae/textures.ts` | procedural canvas textures (`makeGlowTexture`, `makeFlareTexture`) — **zero external assets** |
| `src/lib/nurae/engine.ts` | `NuraeEngine` class + `LOOP_END` export |
| `src/components/nurae/NuraeExperience.tsx` | `'use client'` — canvas + HUD + wordmark |
| `src/components/nurae/intro-overlay.tsx` | `'use client'` — boot layer, `dynamicImport(..., { ssr: false })` |
| `src/app/layout.tsx` | fonts, pre-paint boot script, `<NuraeIntroOverlay />` |
| `src/app/globals.css` | `.nurae-*` rules (boot hiding, vignette, grain, loading bar) |

## 3. Engine API

```ts
import { NuraeEngine, LOOP_END } from '@/lib/nurae/engine'

const engine = new NuraeEngine(canvas, {
  onPhase: (index: number) => {},          // 0..5, fires on beat change
  onTick: (s: { t, flash, readyW, progress, fade }) => {},  // every frame
})
engine.start()     // builds the GL context; safe to call once
engine.restart()   // seek(0)
engine.seek(t)     // deterministic jump (t is modulo LOOP_END; flow re-integrated)
engine.dispose()   // full GL cleanup — MUST run on unmount
```

- `LOOP_END = 12.0` — total loop length in seconds.
- The scene is a **pure function of the timeline**: every visual quantity is
  derived from `t`; the flow displacement is re-integrated on `seek`, so
  verification frames are deterministic.
- Timeline safety: frame `dt` capped at 0.5s (background-tab rAF throttling
  never corrupts the timeline or jumps the seam).
- DPR policy: `renderer.setPixelRatio` and `composer.setPixelRatio` are always
  paired — 1.8 desktop / 1.5 when `min(w, h) < 520`.

## 4. Component props (integration.md Option A)

```tsx
<NuraeExperience />                        // standalone: continuous loop, R restarts
<NuraeExperience playOnce onComplete={fn} />
```

- `playOnce` — one-time-intro mode; without the props the experience loops forever.
- `onComplete` — fires ~1.2s after the READY wordmark reveal begins, giving the
  parent time to fade its boot layer and unmount the component (the cleanup
  calls `engine.dispose()`).
- A WebGL failure completes the intro immediately — the loader can never trap
  the user.
- Keyboard `R` restarts the sequence in both modes.

## 5. Boot sequence (multi-route sites mount the overlay in `layout.tsx`)

The inline pre-paint script in `layout.tsx` decides per browser session:

- `sessionStorage.nuraeIntroDone === '1'` → `data-nurae-intro='done'` → the
  overlay never renders; the site shows immediately.
- otherwise → `data-nurae-intro='pending'` → `globals.css` hides
  `body > :not(.nurae-boot-layer)` so no site content flashes under the loader.
- 15s failsafe force-reveals the site if hydration ever fails.

On completion the overlay sets the flag + attribute, fades 700ms, unmounts.

## 6. URL params

| Param | Effect |
|---|---|
| `?static` | Frozen-frame opt-in: the engine holds inside the READY window (`t ≈ 10.0–11.1`, ambient drift only, never a replay). **The only sanctioned frozen state.** |

## 7. Motion policy (LOCKED PRODUCT DECISIONS — do not regress)

1. Never render phase names or timeframes in the UI.
2. The loader plays UNCONDITIONALLY. `prefers-reduced-motion` must NOT freeze it
   (many Android phones report it permanently; a frozen loader looks broken).
   `?static` is the only opt-out.
3. Seamless loop — no visible seam pop (verified: frame at `t` is
   pixel-identical to `t + LOOP_END`).
4. `engine.dispose()` runs on unmount; resize keeps the DPR pairing.
5. Frame `dt` cap 0.5s.

## 8. CSS classes (globals.css — do not delete)

`.nurae-boot-layer` · `.nurae-vignette` · `.nurae-grain` · `.nurae-loading`
(blink) · `.nurae-track[data-ready]` / `.nurae-dash` (loading bar). The HUD
renders `NURAE / RESOLVING` microcopy (top-left), six beat dots (right edge)
and the centered `NURAE / Your AI. Your world.` lockup on READY.

## 9. Performance notes

- Draw calls ≈ 13 + bloom: 5 field quads, 1 axis, 3 wave quads, 4 sprites,
  2 particle systems, 1 star layer. No full-screen passes beyond the single
  UnrealBloom (strength 0.26, threshold 0.72).
- All motion is shader-side or uniform updates; the DOM holds only static HUD
  text, the vignette and the grain.
- Verified fluid at 390×844 (DPR 1.5) and 1440×900 (DPR 1.8).

## 10. Verification hooks

`window.__nuraeT` (timeline seconds) · `window.__nuraeFreeze = true` (freeze) ·
`window.__nuraeSeek(t)` / `window.__nuraeRestart()` / `window.__nuraeComposer` ·
`window.__nuraeStarted` (boot counter). Drive with `agent-browser`:
`eval "window.__nuraeFreeze=true; window.__nuraeSeek(t)"` → screenshot.

Note for QA: in `playOnce` mode, seeking to `t ≥ 9.3` triggers the one-time
completion 1.2s later and unmounts the engine. For frozen beat captures,
neutralise the handoff timer first (drop `setTimeout(fn, 1200)` calls) or run
the standalone (no-props) experience.

Checklist: seam identity (`t` vs `t + LOOP_END`), all six beats land, READY
lockup, R restart, no phase text in the UI, mobile advances `__nuraeT` in real
time, zero console errors, `npm run lint` clean, `npm run build` passes.
