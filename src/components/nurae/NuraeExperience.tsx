'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NuraeEngine } from '@/lib/nurae/engine'
import { PHASES } from '@/lib/nurae/phases'

const MONO = "'Share Tech Mono', ui-monospace, 'Cascadia Mono', Menlo, monospace"
const MARK = "'Julius Sans One', 'Helvetica Neue', 'Segoe UI', sans-serif"
const TAG = "'Jost', 'Helvetica Neue', 'Segoe UI', sans-serif"

/**
 * NURAE WebGL loading experience (8-phase storyboard, 12s seamless loop).
 *
 * Site integration (Option A in integration.md): pass `playOnce` + `onComplete`
 * — onComplete fires ~1.2s after the READY wordmark begins its reveal, giving
 * the parent time to fade the boot overlay and unmount this component.
 * Without the props it behaves exactly like the standalone experience
 * (continuous loop, keyboard R restart).
 */
export default function NuraeExperience({
  playOnce = false,
  onComplete,
}: {
  playOnce?: boolean
  onComplete?: () => void
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const dashRef = useRef<HTMLDivElement>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<NuraeEngine | null>(null)
  const readyRef = useRef(false)
  const completedRef = useRef(false)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    // latest-ref pattern — keeps the engine callbacks below seeing fresh props
    // without re-creating the engine
    onCompleteRef.current = onComplete
  })

  const [phase, setPhase] = useState(0)
  const [ready, setReady] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    let engine: NuraeEngine | null = null
    try {
      engine = new NuraeEngine(canvasRef.current!, {
        onPhase: (i) => {
          setPhase(i)
          if (i >= 7 && !readyRef.current) {
            readyRef.current = true
            setReady(true)
            // one-time intro: hand off to the site ~1.2s after the wordmark
            // reveal starts (integration.md §6 Option A)
            if (playOnce && !completedRef.current) {
              window.setTimeout(() => {
                if (!completedRef.current) {
                  completedRef.current = true
                  onCompleteRef.current?.()
                }
              }, 1200)
            }
          } else if (i < 7 && readyRef.current) {
            // loop wrap / seek backwards — reset READY state for the next cycle
            readyRef.current = false
            setReady(false)
          }
        },
        onTick: ({ flash, progress, fade }) => {
          if (flashRef.current) flashRef.current.style.opacity = String(flash)
          if (dashRef.current && !readyRef.current) dashRef.current.style.left = `${progress * 100}%`
          // wordmark block rides the loop seam fade with the scene
          if (fadeRef.current) fadeRef.current.style.opacity = String(readyRef.current ? fade : 1)
        },
      })
    } catch (err) {
      // WebGL unavailable / context creation failed — never trap the user
      // behind the loader; hand off to the site immediately.
      console.error('NURAE loader: engine failed to start', err)
      completedRef.current = true
      onCompleteRef.current?.()
      return
    }
    engine.start()
    engineRef.current = engine
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => {
      cancelAnimationFrame(raf)
      readyRef.current = false
      engine.dispose()
      engineRef.current = null
    }
    // engine is created exactly once on mount (react-hooks/exhaustive-deps is
    // off project-wide; the empty dep array here is deliberate)
  }, [])

  const replay = useCallback(() => {
    readyRef.current = false
    setReady(false)
    setPhase(0)
    engineRef.current?.restart()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r') replay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [replay])

  const cornersVisible = mounted ? 'opacity-100' : 'opacity-0'

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#010208] select-none" aria-label="NURAE AI platform loading animation">
      <h1 className="sr-only">NURAE — Your AI. Your world.</h1>

      {/* WebGL scene */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />

      {/* filmic vignette + grain */}
      <div className="nurae-vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="nurae-grain pointer-events-none absolute -inset-16 opacity-[0.05] mix-blend-soft-light" aria-hidden />

      {/* collapse / reveal flash */}
      <div ref={flashRef} className="pointer-events-none absolute inset-0 bg-[#dcecff]" style={{ opacity: 0 }} aria-hidden />

      {/* ---------- corner HUD ---------- */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-[1800ms] ${cornersVisible}`}
        style={{ fontFamily: MONO }}
        aria-hidden
      >
        <div className="absolute left-5 top-5 text-[9px] leading-[1.9] tracking-[0.32em] text-[#7d8ab4]/80 sm:left-8 sm:top-7 sm:text-[10px]">
          <div>NURAE</div>
          <div>AI PLATFORM</div>
          <div className="nurae-loading">LOADING</div>
        </div>
        <div className="absolute right-5 top-5 text-right text-[9px] leading-[1.9] tracking-[0.32em] text-[#7d8ab4]/80 sm:right-8 sm:top-7 sm:text-[10px]">
          <div>MORE</div>
          <div>THAN</div>
          <div>CHAT</div>
        </div>
        <div className="absolute bottom-6 left-5 text-[9px] leading-[1.9] tracking-[0.32em] text-[#7d8ab4]/80 sm:bottom-9 sm:left-8 sm:text-[10px]">
          <div>BUILD</div>
          <div>CREATE</div>
          <div>AUTOMATE</div>
        </div>
        <div className="absolute bottom-6 right-5 text-right text-[9px] leading-[1.9] tracking-[0.32em] text-[#7d8ab4]/80 sm:bottom-9 sm:right-8 sm:text-[10px]">
          <div>NURAE</div>
          <div>EST 2026</div>
          <div className="text-[11px] sm:text-xs">&infin;</div>
        </div>

        {/* right-edge phase dots */}
        <div className="absolute right-5 top-1/2 flex -translate-y-1/2 flex-col items-center gap-[9px] sm:right-8">
          {PHASES.map((ph, i) => (
            <span
              key={ph.id}
              className="block h-[3px] w-[3px] rounded-full transition-all duration-700"
              style={
                i === phase
                  ? { background: '#a9c6ff', boxShadow: '0 0 8px 2px rgba(140,170,255,0.8)', transform: 'scale(1.7)' }
                  : { background: 'rgba(150,165,205,0.28)' }
              }
            />
          ))}
          <span className="mt-1 block text-[9px] text-[#7d8ab4]/70">&#10022;</span>
        </div>
      </div>

      {/* ---------- hero wordmark (READY) ---------- */}
      <div ref={fadeRef} className="pointer-events-none absolute bottom-[7.5%] left-1/2 flex -translate-x-1/2 flex-col items-center sm:bottom-[9%]">
        <div
          className={`whitespace-nowrap text-[26px] text-[#eef2ff] transition-all duration-[1600ms] ease-out sm:text-[42px] ${
            ready ? 'opacity-100' : 'opacity-0'
          }`}
          style={{
            fontFamily: MARK,
            letterSpacing: ready ? '0.46em' : '0.85em',
            marginLeft: ready ? '0.46em' : '0.85em',
            textShadow: '0 0 26px rgba(130,165,255,0.5), 0 0 70px rgba(80,120,255,0.3)',
          }}
        >
          NURAE
        </div>
        <div
          className={`mt-2 text-[11px] font-light tracking-[0.24em] text-[#8b97b8] transition-opacity delay-500 duration-[1400ms] sm:mt-3 sm:text-sm ${
            ready ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ fontFamily: TAG, marginLeft: '0.24em' }}
        >
          Your AI. Your world.
        </div>

        {/* loading bar */}
        <div
          data-ready={ready}
          className={`nurae-track relative mt-5 h-px w-52 transition-opacity duration-1000 sm:mt-6 sm:w-64 ${
            ready ? 'opacity-100' : 'opacity-70'
          }`}
          style={{ background: 'rgba(143,165,216,0.18)' }}
          aria-hidden
        >
          <div
            ref={dashRef}
            className="nurae-dash absolute -top-px h-[3px] w-8 rounded-full"
            style={{
              left: '0%',
              background: 'linear-gradient(90deg, rgba(90,130,255,0), #cfe0ff 45%, #ffffff 55%, rgba(90,130,255,0))',
              boxShadow: '0 0 12px 2px rgba(120,160,255,0.65)',
            }}
          />
        </div>
      </div>
    </div>
  )
}
