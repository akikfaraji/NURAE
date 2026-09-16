/**
 * NURAE — storyboard timeline (v3 — "Reality is being resolved")
 *
 * Six beats, one idea: a measurement axis stands still while reality drifts
 * around it as fine restless marks — then the system understands, everything
 * locks into order around the axis, collapses into it, and the last point
 * becomes the identity.
 *
 * 01 VOID               0.0 – 1.1   black; one microscopic point; the axis draws
 * 02 PERCEPTION         1.1 – 3.6   depth layers reveal — information was already there
 * 03 INFINITE APPROACH  3.6 – 6.3   flow accelerates; the point never grows
 * 04 RESOLUTION         6.3 – 7.9   one lock wave sweeps out; chaos snaps to a polar instrument
 * 05 COLLAPSE           7.9 – 9.3   the instrument dives into the axis; axis → point
 * 06 NURAE              9.3 – 12.0  the point becomes the identity; READY hold; seam fade
 *
 * PHASES is internal timing data only — NEVER render phase names in the UI.
 */

export interface Phase {
  id: string
  name: string
  window: string
  start: number
  end: number
}

export const PHASES: Phase[] = [
  { id: '01', name: 'VOID', window: '0.0s – 1.1s', start: 0.0, end: 1.1 },
  { id: '02', name: 'PERCEPTION', window: '1.1s – 3.6s', start: 1.1, end: 3.6 },
  { id: '03', name: 'INFINITE APPROACH', window: '3.6s – 6.3s', start: 3.6, end: 6.3 },
  { id: '04', name: 'RESOLUTION', window: '6.3s – 7.9s', start: 6.3, end: 7.9 },
  { id: '05', name: 'COLLAPSE', window: '7.9s – 9.3s', start: 7.9, end: 9.3 },
  { id: '06', name: 'NURAE', window: '9.3s +', start: 9.3, end: Infinity },
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

export const easeInCubic = (x: number) => Math.pow(clamp01(x), 3)

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

/** key timeline moments (seconds) — every consumer reads these, never literals */
export const T = {
  /* beat windows */
  voidEnd: 1.1,
  perceptionEnd: 3.6,
  approachEnd: 6.3,
  resolutionEnd: 7.9,
  collapseEnd: 9.3,

  /* reveals */
  pointIn: [0.12, 0.6] as const, // the microscopic point
  axisGrow: [0.7, 1.7] as const, // the axis draws out from the point
  layerIn: [1.15, 3.4] as const, // far → near field reveal window

  /* perception pulse — the first measurement wave (setup for the lock wave) */
  pulseAt: 1.2,

  /* infinite approach */
  flowRamp: [3.6, 6.25] as const, // outward flow accelerates
  flowStop: [6.3, 6.68] as const, // abrupt-but-smooth halt

  /* resolution */
  lockWave: [6.45, 7.5] as const, // lock radius sweeps 0 → maxR
  settle: 7.6, // fully ordered, hold one beat

  /* collapse */
  collapse: [7.9, 9.18] as const,
  axisPeak: 8.75, // axis brightness peak while drinking the structure
  axisVanish: [9.0, 9.32] as const, // scaleY → 0.012, only the point remains
  flashAt: 9.26, // one 40ms blink as the axis finishes

  /* identity */
  ready: 9.45, // wordmark reveal begins
  readyFull: 10.9, // lockup fully settled
  idle: 10.9, // pure ambient hold

  /* loop seam (master fade) */
  fadeOut: [11.35, 11.92] as const,
}
