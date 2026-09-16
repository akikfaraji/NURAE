/**
 * NURAE — storyboard timeline
 * Mirrors the 8-frame storyboard exactly:
 * 01 INITIAL POINT 0.0–0.6 · 02 LAYERS REVEAL 0.6–1.4 · 03 INFINITE EXPANSION 1.4–2.8
 * 04 DEPTH & PERSPECTIVE 2.8–4.2 · 05 THE EYE OPENS 4.2–5.8 · 06 COLLAPSE 5.8–6.8
 * 07 REBORN 6.8–7.4 · 08 READY 7.4+
 */

export interface Phase {
  id: string
  name: string
  window: string
  start: number
  end: number
}

export const PHASES: Phase[] = [
  { id: '01', name: 'INITIAL POINT', window: '0.0s – 0.6s', start: 0.0, end: 0.6 },
  { id: '02', name: 'LAYERS REVEAL', window: '0.6s – 1.4s', start: 0.6, end: 1.4 },
  { id: '03', name: 'INFINITE EXPANSION', window: '1.4s – 2.8s', start: 1.4, end: 2.8 },
  { id: '04', name: 'DEPTH & PERSPECTIVE', window: '2.8s – 4.2s', start: 2.8, end: 4.2 },
  { id: '05', name: 'THE EYE OPENS', window: '4.2s – 5.8s', start: 4.2, end: 5.8 },
  { id: '06', name: 'COLLAPSE', window: '5.8s – 6.8s', start: 5.8, end: 6.8 },
  { id: '07', name: 'REBORN', window: '6.8s – 7.4s', start: 6.8, end: 7.4 },
  { id: '08', name: 'READY', window: '7.4s +', start: 7.4, end: Infinity },
]

/* ---------- easing helpers ---------- */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** smoothstep between a..b evaluated at t */
export const sm = (t: number, a: number, b: number) => {
  const x = clamp01((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}

/** gaussian bell centered at c with width w */
export const bell = (t: number, c: number, w: number) => {
  const d = (t - c) / w
  return Math.exp(-d * d)
}

export const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)

export const easeOutBack = (x: number) => {
  const c1 = 1.20158
  const c3 = c1 + 1
  const y = clamp01(x)
  return 1 + c3 * Math.pow(y - 1, 3) + c1 * Math.pow(y - 1, 2)
}

export const easeInOutCubic = (x: number) => {
  const y = clamp01(x)
  return y < 0.5 ? 4 * y * y * y : 1 - Math.pow(-2 * y + 2, 3) / 2
}

/** key timeline moments (seconds) */
export const T = {
  hide: [6.68, 6.76] as const, // global blackout during collapse flash
  flashAt: 6.78,
  reborn: [6.86, 7.2] as const,
  ready: 7.4,
  idle: 8.8, // everything settled, pure ambient drift
}
