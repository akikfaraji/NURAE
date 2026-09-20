'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamicImport from 'next/dynamic'

/**
 * Client-only mount of the WebGL experience — the canvas + timeline need the
 * browser (integration.md §6 placement rules). ssr:false is only allowed
 * inside a client component, which is exactly what this wrapper is for.
 */
const NuraeExperience = dynamicImport(() => import('@/components/nurae/NuraeExperience'), { ssr: false })

type BootState = 'waiting' | 'playing' | 'fading' | 'done'

const FADE_MS = 700

/**
 * NURAE intro boot overlay (integration.md §6 Option A — one-time intro).
 *
 * The pre-paint boot <script> in app/layout.tsx sets data-nurae-intro on
 * <html> before first paint:
 *   - 'pending' → the intro will play; CSS hides the site behind this opaque
 *     layer so there is never a flash of the site under the loader.
 *   - 'done'    → already played this browser session (sessionStorage) —
 *     this component never renders and the site shows immediately.
 *
 * On READY the experience hands off: sessionStorage flag + attribute flip
 * (site becomes visible under the opaque layer), then a 700ms fade, then
 * unmount — the engine's cleanup disposes WebGL with no leaks.
 * A WebGL failure inside the experience also completes the intro immediately,
 * so a broken loader can never trap the user away from the site.
 */
export default function NuraeIntroOverlay() {
  // 'waiting' on both server and first client render → hydration always
  // matches; the real decision happens after mount from the boot attribute.
  const [boot, setBoot] = useState<BootState>('waiting')
  const completedRef = useRef(false)
  const fadeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const alreadyDone = document.documentElement.getAttribute('data-nurae-intro') === 'done'
    // Motion policy: never freeze the loader (many Android phones report
    // prefers-reduced-motion permanently — a frozen WebGL frame looks broken).
    // Instead the intro is skipped entirely: reduced-motion users go straight
    // to the site, instantly, with no fade and no canvas ever mounting.
    let reducedMotion = false
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      /* no matchMedia — play normally */
    }
    if (alreadyDone || reducedMotion) {
      if (!alreadyDone) {
        try {
          sessionStorage.setItem('nuraeIntroDone', '1')
        } catch {
          /* private mode */
        }
        document.documentElement.setAttribute('data-nurae-intro', 'done')
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount gate: the boot decision lives in the DOM (set pre-paint), so it can only be read after hydration; SSR always renders 'waiting' to keep hydration matching
      setBoot('done')
      return
    }
    setBoot('playing')
    return () => {
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current)
    }
  }, [])

  const handleComplete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    try {
      sessionStorage.setItem('nuraeIntroDone', '1')
    } catch {
      /* private mode — intro simply replays next full load */
    }
    // reveal the site (CSS stops hiding body children) and start the soft
    // site-rise crossfade under the fading layer, then unmount the engine
    document.documentElement.setAttribute('data-nurae-intro', 'done')
    document.body.classList.add('nurae-revealed')
    setBoot('fading')
    fadeTimerRef.current = window.setTimeout(() => setBoot('done'), FADE_MS + 50)
  }, [])

  if (boot === 'waiting' || boot === 'done') return null

  return (
    <div
      className="nurae-boot-layer fixed inset-0 z-[100] bg-[#010208] transition-opacity duration-700 ease-in-out"
      style={{ opacity: boot === 'fading' ? 0 : 1 }}
      aria-hidden="true"
    >
      <NuraeExperience playOnce onComplete={handleComplete} />
    </div>
  )
}
