/**
 * NURAE — WebGL animation engine (v2 — premium pass)
 * Recreates the 8-phase storyboard in real time with Three.js:
 * point -> layers -> expansion -> perspective -> eye opens -> collapse -> reborn -> ready
 *
 * v2 upgrades:
 *  - orbital system rebuilt as ~24 constant-width glowing ribbon rings with
 *    travelling arc clusters, comet heads and node dots (no more flat lines)
 *  - SDF ripples with angular hotspots replace 1px line circles
 *  - fine wireframe sphere + orbital dust field for extra mesh depth
 *  - the eye phase no longer blows out — core sprites yield to the iris
 *  - seamless 12s loop for continuous loading-screen duty (fade seam)
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { PHASES, sm, bell, pulse, clamp01, easeOutCubic, easeInOutCubic } from './phases'
import { SHADERS } from './shaders'
import { makeFlareTexture, makeGlowTexture } from './textures'

export interface TickState {
  t: number
  flash: number
  readyW: number
  progress: number
  fade: number
}

export interface EngineCallbacks {
  onPhase: (index: number) => void
  onTick: (s: TickState) => void
}

/** total loop length — storyboard (7.4s) + ready hold + fade seam */
export const LOOP_END = 12.0

/** loop seam — the scene eases to black across 11.35-11.92, then phase 01
 *  fades back in over 0.55s with a symmetrical in-out curve (was a faster
 *  linear-ish ramp; the eased version kills the perceptible fade kink). */
const seamFade = (t: number) => easeInOutCubic(sm(t, 0.0, 0.55)) * (1 - sm(t, 11.35, 11.92))

interface RingSpec {
  rx: number
  rz: number
  rotX: number
  rotY: number
  width: number
  op: number
  segs: number
  sharp: number
  speed: number
  comet: number
  cometSpeed: number
  appear: number
  dir: number
  faceCam: boolean
  nodes: { speed: number; offset: number; scale: number }[]
}

interface Ripple {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  born: number
  dur: number
  maxR: number
  active: boolean
}

const node = (speed: number, offset: number, scale: number) => ({ speed, offset, scale })

/** the orbital system — 4 families + camera-facing circles + faint sweeps */
const RING_SPECS: RingSpec[] = [
  /* --- equatorial sweeps (wide flat ellipses) --- slide in through phase 03, one family at a time --- */
  { rx: 3.05, rz: 0.62, rotX: -Math.PI / 2, rotY: 0, width: 0.032, op: 1.25, segs: 3, sharp: 5, speed: 0.55, comet: 0.55, cometSpeed: 0.05, appear: 1.95, dir: 1, faceCam: false, nodes: [node(0.42, 1.2, 0.11)] },
  { rx: 3.78, rz: 0.90, rotX: -Math.PI / 2 + 0.05, rotY: 0.10, width: 0.026, op: 0.9, segs: 2, sharp: 3, speed: -0.30, comet: 0, cometSpeed: 0, appear: 2.15, dir: 1, faceCam: false, nodes: [node(-0.26, 3.9, 0.08)] },
  { rx: 2.62, rz: 0.44, rotX: -Math.PI / 2 - 0.09, rotY: -0.15, width: 0.024, op: 1.0, segs: 5, sharp: 6, speed: 0.42, comet: 0, cometSpeed: 0, appear: 2.35, dir: -1, faceCam: false, nodes: [] },
  { rx: 4.28, rz: 1.06, rotX: -Math.PI / 2 + 0.02, rotY: 0.22, width: 0.024, op: 0.7, segs: 2, sharp: 4, speed: -0.22, comet: 0, cometSpeed: 0, appear: 2.5, dir: -1, faceCam: false, nodes: [] },
  { rx: 3.35, rz: 0.55, rotX: -Math.PI / 2 + 0.14, rotY: 0.50, width: 0.022, op: 0.75, segs: 3, sharp: 7, speed: 0.60, comet: 0, cometSpeed: 0, appear: 2.65, dir: 1, faceCam: false, nodes: [] },
  { rx: 2.30, rz: 0.30, rotX: -Math.PI / 2 - 0.18, rotY: 0.08, width: 0.020, op: 0.65, segs: 4, sharp: 5, speed: -0.50, comet: 0, cometSpeed: 0, appear: 2.8, dir: 1, faceCam: false, nodes: [] },
  { rx: 3.60, rz: 0.75, rotX: -Math.PI / 2 - 0.05, rotY: -0.35, width: 0.018, op: 0.55, segs: 4, sharp: 5, speed: 0.35, comet: 0, cometSpeed: 0, appear: 2.95, dir: -1, faceCam: false, nodes: [] },

  /* --- tall vertical ovals (the great cage) --- */
  { rx: 2.35, rz: 2.35, rotX: 0.06, rotY: 0.42, width: 0.032, op: 1.15, segs: 2, sharp: 4, speed: 0.40, comet: 0.6, cometSpeed: 0.045, appear: 2.8, dir: 1, faceCam: false, nodes: [node(0.55, 1.57, 0.10)] },
  { rx: 2.35, rz: 2.35, rotX: -0.05, rotY: -0.46, width: 0.026, op: 0.9, segs: 2, sharp: 3, speed: -0.36, comet: 0, cometSpeed: 0, appear: 3.0, dir: -1, faceCam: false, nodes: [node(-0.48, 4.7, 0.08)] },
  { rx: 2.78, rz: 2.78, rotX: 0.12, rotY: 0.30, width: 0.022, op: 0.62, segs: 3, sharp: 5, speed: 0.25, comet: 0, cometSpeed: 0, appear: 3.25, dir: 1, faceCam: false, nodes: [] },

  /* --- diagonal mid rings --- */
  { rx: 2.05, rz: 2.05, rotX: 1.25, rotY: 0.35, width: 0.024, op: 0.85, segs: 3, sharp: 4, speed: 0.70, comet: 0.75, cometSpeed: -0.06, appear: 3.15, dir: 1, faceCam: false, nodes: [node(0.70, 0.4, 0.09)] },
  { rx: 1.85, rz: 1.85, rotX: -1.15, rotY: -0.40, width: 0.022, op: 0.72, segs: 4, sharp: 6, speed: -0.60, comet: 0, cometSpeed: 0, appear: 3.35, dir: -1, faceCam: false, nodes: [] },
  { rx: 2.52, rz: 2.52, rotX: 0.85, rotY: -0.70, width: 0.022, op: 0.62, segs: 2, sharp: 3, speed: 0.30, comet: 0, cometSpeed: 0, appear: 3.5, dir: 1, faceCam: false, nodes: [] },
  { rx: 2.20, rz: 2.20, rotX: 1.50, rotY: 0.90, width: 0.018, op: 0.55, segs: 3, sharp: 5, speed: 0.45, comet: 0, cometSpeed: 0, appear: 3.65, dir: -1, faceCam: false, nodes: [] },
  { rx: 2.65, rz: 2.65, rotX: -0.70, rotY: 0.75, width: 0.018, op: 0.52, segs: 2, sharp: 3, speed: -0.28, comet: 0, cometSpeed: 0, appear: 3.8, dir: 1, faceCam: false, nodes: [] },

  /* --- inner rings hugging the iris --- */
  { rx: 1.28, rz: 1.28, rotX: 1.35, rotY: 0.20, width: 0.024, op: 0.95, segs: 2, sharp: 5, speed: 0.90, comet: 0.65, cometSpeed: 0.09, appear: 4.2, dir: 1, faceCam: false, nodes: [node(0.90, 5.1, 0.07)] },
  { rx: 1.05, rz: 1.05, rotX: -1.20, rotY: -0.30, width: 0.020, op: 0.8, segs: 3, sharp: 6, speed: -0.80, comet: 0, cometSpeed: 0, appear: 4.35, dir: -1, faceCam: false, nodes: [] },
  { rx: 1.52, rz: 1.52, rotX: 0.35, rotY: 1.10, width: 0.020, op: 0.68, segs: 2, sharp: 4, speed: 0.50, comet: 0, cometSpeed: 0, appear: 4.5, dir: 1, faceCam: false, nodes: [] },
  { rx: 1.70, rz: 1.70, rotX: 0.60, rotY: -1.20, width: 0.018, op: 0.6, segs: 2, sharp: 5, speed: 0.65, comet: 0, cometSpeed: 0, appear: 4.65, dir: -1, faceCam: false, nodes: [] },

  /* --- camera-facing circles: the first two ARE the phase-02 "layers reveal",
         the outer ones join during phase-03 expansion --- */
  { rx: 1.34, rz: 1.34, rotX: 0, rotY: 0, width: 0.022, op: 0.8, segs: 1, sharp: 3, speed: 0.35, comet: 0.5, cometSpeed: 0.07, appear: 0.75, dir: 1, faceCam: true, nodes: [node(0.35, 2.1, 0.08)] },
  { rx: 1.52, rz: 1.52, rotX: 0, rotY: 0, width: 0.018, op: 0.55, segs: 2, sharp: 4, speed: -0.30, comet: 0, cometSpeed: 0, appear: 1.05, dir: 1, faceCam: true, nodes: [] },
  { rx: 3.40, rz: 3.40, rotX: 0, rotY: 0, width: 0.016, op: 0.4, segs: 2, sharp: 5, speed: 0.18, comet: 0, cometSpeed: 0, appear: 2.3, dir: 1, faceCam: true, nodes: [] },
  { rx: 4.15, rz: 4.15, rotX: 0, rotY: 0, width: 0.014, op: 0.3, segs: 3, sharp: 6, speed: -0.14, comet: 0, cometSpeed: 0, appear: 2.6, dir: 1, faceCam: true, nodes: [] },
  { rx: 4.85, rz: 4.85, rotX: 0, rotY: 0, width: 0.014, op: 0.22, segs: 2, sharp: 4, speed: 0.11, comet: 0, cometSpeed: 0, appear: 2.9, dir: 1, faceCam: true, nodes: [] },
]

const RIPPLE_COUNT = 14

export class NuraeEngine {
  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private composer!: EffectComposer
  private bloom!: UnrealBloomPass

  private starMats: THREE.PointsMaterial[] = []
  private dustMat!: THREE.PointsMaterial
  private dust!: THREE.Points
  private nebulaMats: THREE.ShaderMaterial[] = []
  private nebulaMeshes: THREE.Mesh[] = []
  private flare!: THREE.Sprite
  private coreGlow!: THREE.Sprite
  private dot!: THREE.Sprite
  private beamMat!: THREE.ShaderMaterial
  private beam!: THREE.Mesh
  private beamDots: THREE.Sprite[] = []
  private ripples: Ripple[] = []
  private ringMeshes: THREE.Mesh[] = []
  private ringMats: THREE.ShaderMaterial[] = []
  private nodeSprites: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; ring: number; spec: { speed: number; offset: number; scale: number } }[] = []
  private irisMat!: THREE.ShaderMaterial
  private iris!: THREE.Mesh
  private pupilMat!: THREE.ShaderMaterial
  private pupil!: THREE.Mesh
  private halo!: THREE.Sprite
  private wireSphere!: THREE.Mesh
  private wireMat!: THREE.MeshBasicMaterial

  private glowTex!: THREE.CanvasTexture
  private flareTex!: THREE.CanvasTexture
  private orbitGroup = new THREE.Group()

  private raf = 0
  private lastNow = 0
  private t = 0
  private phaseIdx = -1
  private spawnIdx = 0
  private lastSpawn = -10
  private mx = 0
  private my = 0
  private tmx = 0
  private tmy = 0
  private disposed = false

  private canvas: HTMLCanvasElement
  private cb: EngineCallbacks
  private staticHold = false

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks) {
    this.canvas = canvas
    this.cb = cb
  }

  /* ------------------------------------------------------------ */

  start() {
    if (this.renderer) return
    // Motion policy: ALWAYS play the full 8-phase sequence. We previously froze
    // inside the READY hold when the OS reported prefers-reduced-motion, but many
    // Android phones report it permanently ("Remove animations" accessibility
    // setting, developer animation scale off, battery saver), which made the
    // loading screen look stuck on one frame. The frozen READY frame is now an
    // explicit opt-in via the ?static URL param only.
    this.staticHold =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('static')

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#010208')

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120)
    this.camera.position.set(0, 1.15, 7.8)
    this.camera.lookAt(0, -0.4, 0)

    this.glowTex = makeGlowTexture()
    this.flareTex = makeFlareTexture()

    this.buildStars()
    this.buildNebula()
    this.buildPoint()
    this.buildBeam()
    this.buildRipples()
    this.buildOrbits()
    this.buildIris()

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.25, 0.66)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.resize()
    window.addEventListener('resize', this.resize)
    window.addEventListener('pointermove', this.onPointer)

    if (this.staticHold) this.t = 9.2
    this.lastNow = performance.now()
    const dbg = window as unknown as Record<string, unknown>
    dbg.__nuraeT = this.t
    dbg.__nuraeStarted = (dbg.__nuraeStarted as number ?? 0) + 1
    this.raf = requestAnimationFrame(this.loop)
  }

  restart() {
    this.seek(0)
  }

  /** jump to an exact storyboard time (used for deterministic verification) */
  seek(t: number) {
    this.t = t
    this.phaseIdx = -1
    this.spawnIdx = 0
    for (const r of this.ripples) {
      r.active = false
      r.mesh.visible = false
    }
    // pre-fill the ripple field exactly as a live run would have spawned it
    if (t > 0.65) {
      let born = 0.65
      let idx = 0
      while (born < Math.min(t, 3.55)) {
        const age = t - born
        const dur = 2.6 + (idx % 2) * 0.5
        if (age < dur) {
          const r = this.ripples[idx % this.ripples.length]
          r.active = true
          r.born = born
          r.dur = dur
          r.maxR = 4.3 + (idx % 3) * 0.4
        }
        born += 0.58
        idx++
      }
      this.spawnIdx = idx % this.ripples.length
      this.lastSpawn = born - 0.58
    } else {
      this.lastSpawn = -10
    }
    this.cb.onPhase(t >= 7.4 ? 7 : 0)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('pointermove', this.onPointer)
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    this.glowTex?.dispose()
    this.flareTex?.dispose()
    this.composer?.dispose()
    this.renderer?.dispose()
  }

  /* ------------------------------------------------------------ */

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    // phones: slightly lower render resolution so the 24-ring scene + bloom stays fluid
    const small = Math.min(w, h) < 520
    const pr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.8)
    this.renderer.setPixelRatio(pr)
    this.composer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    const aspect = w / h
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  private onPointer = (e: PointerEvent) => {
    this.tmx = (e.clientX / window.innerWidth) * 2 - 1
    this.tmy = (e.clientY / window.innerHeight) * 2 - 1
  }

  private loop = (now: number) => {
    if (this.disposed) return
    // wall-clock timing; large gaps (background tab) are capped so the
    // animation never stalls under rAF throttling
    const rawDt = (now - this.lastNow) / 1000
    const dt = Math.min(Math.max(rawDt, 0), 0.5)
    this.lastNow = now
    const dbg = window as unknown as Record<string, unknown>
    if (!dbg.__nuraeFreeze) {
      if (this.staticHold) {
        // ?static opt-in: ambient drift inside the READY hold, never a replay
        this.t = 9.2 + (this.t - 9.2 + dt) % 2.1
      } else {
        this.t += dt
        if (this.t >= LOOP_END) this.t -= LOOP_END
      }
    }
    this.update(this.t, dt)
    this.composer.render()

    const t = this.t
    // collapse flash: fast attack / ~0.3s eased release (reads as light, not a
    // glitch pop); the eye-flash at 4.32 gets the same shaping, quieter
    const flash = pulse(t, 6.78, 0.035, 0.34) + pulse(t, 4.32, 0.05, 0.24) * 0.16
    const idx = PHASES.findIndex((p) => t >= p.start && t < p.end)
    const phase = idx === -1 ? PHASES.length - 1 : idx
    if (phase !== this.phaseIdx) {
      this.phaseIdx = phase
      this.cb.onPhase(phase)
    }
    const fade = seamFade(t)
    this.cb.onTick({
      t,
      flash: Math.min(1, flash),
      readyW: sm(t, 7.55, 8.8) * fade,
      progress: clamp01(t / 8.2),
      fade,
    })
    ;(window as unknown as Record<string, unknown>).__nuraeT = t
    ;(window as unknown as Record<string, unknown>).__nuraeSeek = (tt: number) => this.seek(tt)
    ;(window as unknown as Record<string, unknown>).__nuraeRestart = () => this.restart()
    ;(window as unknown as Record<string, unknown>).__nuraeComposer = this.composer
    this.raf = requestAnimationFrame(this.loop)
  }

  /* ------------------------------------------------------------ */

  private buildStars() {
    const makeLayer = (count: number, size: number, rMin: number, rMax: number) => {
      const pos = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const r = rMin + Math.random() * (rMax - rMin)
        const th = Math.random() * Math.PI * 2
        const ph = Math.acos(2 * Math.random() - 1)
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.7
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const mat = new THREE.PointsMaterial({
        size,
        map: this.glowTex,
        color: 0xbfd2ff,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      const pts = new THREE.Points(geo, mat)
      this.scene.add(pts)
      this.starMats.push(mat)
    }
    makeLayer(460, 0.075, 13, 34)
    makeLayer(140, 0.16, 15, 30)
  }

  /** fine dust drifting in the orbital plane — extra mesh density */
  private buildDust() {
    const count = 850
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = 0.6 + Math.pow(Math.random(), 0.7) * 4.6
      const th = Math.random() * Math.PI * 2
      pos[i * 3] = r * Math.cos(th)
      pos[i * 3 + 1] = (Math.random() - 0.5) * 2.6 * (1.15 - r / 6.0)
      pos[i * 3 + 2] = r * Math.sin(th) * (0.55 + Math.random() * 0.4)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.dustMat = new THREE.PointsMaterial({
      size: 0.033,
      map: this.glowTex,
      color: 0x9fbaff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    this.dust = new THREE.Points(geo, this.dustMat)
    this.orbitGroup.add(this.dust)
  }

  private buildNebula() {
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHADERS.QUAD_VERT,
        fragmentShader: SHADERS.NEBULA_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uSeed: { value: i * 13.7 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), mat)
      mesh.position.set((i - 1) * 3.4, (i % 2 === 0 ? 1 : -1) * 1.6, -6 - i * 1.5)
      mesh.rotation.z = i * 1.1
      this.scene.add(mesh)
      this.nebulaMats.push(mat)
      this.nebulaMeshes.push(mesh)
    }
  }

  private buildPoint() {
    const mk = (tex: THREE.Texture, scale: number, opacity: number) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const s = new THREE.Sprite(mat)
      s.scale.setScalar(scale)
      this.scene.add(s)
      return s
    }
    this.coreGlow = mk(this.glowTex, 0.95, 0)
    this.flare = mk(this.flareTex, 0.5, 0)
    this.dot = mk(this.glowTex, 0.15, 0)
    this.halo = mk(this.glowTex, 3.8, 0)
    ;(this.halo.material as THREE.SpriteMaterial).color = new THREE.Color(0x3f6cff)
    this.halo.position.z = -0.05
  }

  private buildBeam() {
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: SHADERS.QUAD_VERT,
      fragmentShader: SHADERS.BEAM_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uGrow: { value: 0 },
        uIntensity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 11), this.beamMat)
    this.beam.position.z = 0.02
    this.scene.add(this.beam)

    for (let i = 0; i < 2; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: 0xd8e6ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const s = new THREE.Sprite(mat)
      s.scale.setScalar(0.12)
      s.position.set(0, i === 0 ? 2.3 : -2.3, 0.03)
      this.scene.add(s)
      this.beamDots.push(s)
    }
  }

  private buildRipples() {
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHADERS.QUAD_VERT,
        fragmentShader: SHADERS.RIPPLE_FRAG,
        uniforms: {
          uR: { value: 0.1 },
          uScale: { value: 5.3 },
          uIntensity: { value: 0 },
          uSeed: { value: 1.7 + i * 0.83 },
          uTime: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10.6, 10.6), mat)
      mesh.visible = false
      mesh.position.z = 0.015
      this.scene.add(mesh)
      this.ripples.push({ mesh, mat, born: 0, dur: 1.7, maxR: 4.6, active: false })
    }
  }

  /** shared unit ribbon geometry — the actual ellipse lives in the shader */
  private makeRibbonGeometry(segments = 260): THREE.BufferGeometry {
    const verts = segments + 1
    const pos = new Float32Array(verts * 2 * 3)
    const angle = new Float32Array(verts * 2)
    const side = new Float32Array(verts * 2)
    const index = new Uint32Array(segments * 6)
    for (let i = 0; i < verts; i++) {
      const a = (i / segments) * Math.PI * 2
      const x = Math.cos(a)
      const y = Math.sin(a)
      pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = 0
      pos[i * 6 + 3] = x; pos[i * 6 + 4] = y; pos[i * 6 + 5] = 0
      angle[i * 2] = a; angle[i * 2 + 1] = a
      side[i * 2] = -1; side[i * 2 + 1] = 1
    }
    for (let i = 0; i < segments; i++) {
      const o = i * 2
      index.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], i * 6)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1))
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    return geo
  }

  private buildOrbits() {
    this.scene.add(this.orbitGroup)
    const ribbon = this.makeRibbonGeometry()

    RING_SPECS.forEach((spec, i) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHADERS.RING_VERT,
        fragmentShader: SHADERS.RING_FRAG,
        uniforms: {
          uRx: { value: spec.rx },
          uRz: { value: spec.rz },
          uWidth: { value: spec.width },
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uSeed: { value: i * 1.37 + 0.61 },
          uSegs: { value: spec.segs },
          uSharp: { value: spec.sharp },
          uSpeed: { value: spec.speed },
          uComet: { value: spec.comet },
          uCometSpeed: { value: spec.cometSpeed },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
      const ring = new THREE.Mesh(ribbon, mat)
      ring.rotation.set(spec.rotX, spec.rotY, 0)
      ring.frustumCulled = false
      ring.visible = false
      this.orbitGroup.add(ring)
      this.ringMeshes.push(ring)
      this.ringMats.push(mat)

      spec.nodes.forEach((n) => {
        const nmat = new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0xdde9ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const sprite = new THREE.Sprite(nmat)
        sprite.scale.setScalar(n.scale)
        this.orbitGroup.add(sprite)
        this.nodeSprites.push({ sprite, mat: nmat, ring: i, spec: n })
      })
    })

    // fine wireframe sphere — subtle mesh depth around the whole system
    this.wireMat = new THREE.MeshBasicMaterial({
      color: 0x3d5ef0,
      wireframe: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.wireSphere = new THREE.Mesh(new THREE.SphereGeometry(2.9, 36, 22), this.wireMat)
    this.wireSphere.rotation.x = 0.42
    this.wireSphere.visible = false
    this.orbitGroup.add(this.wireSphere)
    this.buildDust()
  }

  private buildIris() {
    this.irisMat = new THREE.ShaderMaterial({
      vertexShader: SHADERS.QUAD_VERT,
      fragmentShader: SHADERS.IRIS_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpen: { value: 0 },
        uSwirl: { value: 0 },
        uBoost: { value: 0 },
        uSeed: { value: 5.2 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.iris = new THREE.Mesh(new THREE.PlaneGeometry(2.35, 2.35), this.irisMat)
    this.iris.position.z = 0.01
    this.scene.add(this.iris)

    // occluding dark pupil — normal blending so it stays genuinely dark
    this.pupilMat = new THREE.ShaderMaterial({
      vertexShader: SHADERS.QUAD_VERT,
      fragmentShader: SHADERS.PUPIL_FRAG,
      uniforms: { uOpen: { value: 0 } },
      transparent: true,
      depthWrite: false,
    })
    this.pupil = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), this.pupilMat)
    this.pupil.position.z = 0.015
    this.scene.add(this.pupil)
  }

  /* ------------------------------------------------------------ */

  private updateRipples(t: number, master: number, collapseE: number) {
    // spawn stream while phase 02-03 window is live
    if (master > 0.02 && t > 0.62 && t < 3.55 && t - this.lastSpawn > 0.58) {
      const r = this.ripples[this.spawnIdx % this.ripples.length]
      r.active = true
      r.born = t
      r.dur = 2.6 + (this.spawnIdx % 2) * 0.5
      r.maxR = 4.3 + (this.spawnIdx % 3) * 0.4
      this.spawnIdx++
      this.lastSpawn = t
    }
    const shrink = 1 - 0.85 * collapseE
    for (const r of this.ripples) {
      if (!r.active) continue
      const k = (t - r.born) / r.dur
      if (k >= 1 || master <= 0.001) {
        r.active = false
        r.mesh.visible = false
        continue
      }
      r.mesh.visible = true
      r.mat.uniforms.uTime.value = t
      r.mat.uniforms.uR.value = 0.12 + (r.maxR - 0.12) * easeOutCubic(k) * shrink
      r.mat.uniforms.uIntensity.value = master * Math.pow(1 - k, 1.7) * 0.9 * (1 + collapseE * 1.2)
    }
  }

  private update(t: number, dt: number) {
    const hid = sm(t, 6.68, 6.76)
    // collapse builds 5.8 -> 6.74, holds through the flash, releases during reborn
    const collapseE = easeInOutCubic(sm(t, 5.8, 6.74)) * (1 - sm(t, 6.86, 7.35))
    const collapseS = collapseE * (1 - sm(t, 7.5, 9.0))
    // loop seam — everything eases to black, then phase 01 fades back in
    const fade = seamFade(t)

    const pointW = Math.max(sm(t, 0.05, 0.5) * (1 - hid), sm(t, 6.86, 7.2)) * fade
    const beamW = (sm(t, 0.62, 1.35) * (1 - hid) + sm(t, 7.6, 8.6)) * fade
    const rippleMaster = sm(t, 0.6, 1.0) * (1 - sm(t, 3.5, 4.5)) * (1 - hid) * fade
    const ellipseMaster = (sm(t, 0.7, 2.4) * (1 - hid) + sm(t, 7.65, 9.2)) * fade
    const eyeW = (sm(t, 4.15, 5.75) * (1 - hid) + sm(t, 7.55, 9.0)) * fade
    const nebW = Math.max(sm(t, 3.4, 5.2) * (1 - hid), sm(t, 7.8, 9.5)) * fade
    const swirlPulse = sm(t, 4.2, 4.55) * (1 - sm(t, 5.3, 6.2)) * 1.7

    /* stars */
    const starDip = 1 - 0.7 * bell(t, 7.05, 0.5)
    this.starMats[0].opacity = (0.5 + 0.22 * Math.sin(t * 1.1)) * 0.9 * starDip * fade
    this.starMats[1].opacity = (0.5 + 0.22 * Math.sin(t * 1.7 + 2.1)) * 0.75 * starDip * fade

    /* nebula */
    this.nebulaMats.forEach((m, i) => {
      m.uniforms.uTime.value = t
      m.uniforms.uIntensity.value = 0.13 * nebW
      this.nebulaMeshes[i].rotation.z += dt * 0.012 * (i % 2 === 0 ? 1 : -1)
    })

    /* the point — yields fully to the iris once the eye is open */
    const flarePulse = 0.02 * Math.sin(t * 1.3) + collapseE * 0.5
    const yieldEye = 1 - eyeW * 0.95
    ;(this.flare.material as THREE.SpriteMaterial).opacity = pointW * yieldEye
    this.flare.scale.setScalar((0.52 + flarePulse) * (1 - 0.6 * collapseS) * (1 - eyeW * 0.6))
    ;(this.coreGlow.material as THREE.SpriteMaterial).opacity = pointW * 0.8 * (1 - eyeW * 0.85)
    this.coreGlow.scale.setScalar((0.95 + flarePulse * 0.6) * (1 - 0.6 * collapseS) * (1 - eyeW * 0.75))
    ;(this.dot.material as THREE.SpriteMaterial).opacity = pointW * (1 - eyeW)
    this.dot.scale.setScalar((0.15 + 0.02 * Math.sin(t * 9)) * (1 - eyeW * 0.25))

    /* halo behind iris — mostly for the pre-eye phases */
    ;(this.halo.material as THREE.SpriteMaterial).opacity = 0.22 * Math.max(0.16 * eyeW, pointW * 0.35) * (1 - hid) * fade
    this.halo.scale.setScalar((3.4 + 0.3 * Math.sin(t * 0.8)) * (1 - 0.8 * collapseS))

    /* beam — grow is eased (was a linear ramp that popped against the
       smoothstepped world around it) */
    this.beamMat.uniforms.uTime.value = t
    this.beamMat.uniforms.uGrow.value = Math.max(sm(t, 0.62, 1.37), sm(t, 7.6, 8.5))
    this.beamMat.uniforms.uIntensity.value = beamW * (0.72 + collapseE * 0.9) * (1 - eyeW * 0.22)
    this.beam.scale.set(1, Math.max(1 - 0.94 * collapseS, 0.001), 1)
    const dotW = beamW * Math.max(sm(t, 1.9, 2.5), sm(t, 7.8, 8.6)) * (1 - hid)
    this.beamDots.forEach((d, i) => {
      ;(d.material as THREE.SpriteMaterial).opacity = dotW * (0.82 + 0.18 * Math.sin(t * 1.2 + i * 2.4))
      d.position.y = (i === 0 ? 2.3 : -2.3) + 0.02 * Math.sin(t * 1.6 + i)
    })

    /* ripples */
    this.updateRipples(t, rippleMaster, collapseE)

    /* orbit rings + node dots */
    this.orbitGroup.scale.setScalar(Math.max(1 - 0.85 * collapseE, 0.001))
    RING_SPECS.forEach((spec, i) => {
      const appear = spec.appear
      // re-form after the collapse is staggered from READY, independent of appear
      const reForm = sm(t, 7.62 + (i % 6) * 0.07, 8.72 + (i % 6) * 0.07)
      const inW = Math.max(sm(t, appear, appear + 0.95), reForm) * fade
      const ring = this.ringMeshes[i]
      const mat = this.ringMats[i]
      if (inW <= 0.001) {
        ring.visible = false
        return
      }
      ring.visible = true
      const grow = 0.72 + 0.28 * easeOutCubic(inW)
      ring.scale.setScalar(grow)
      const micro = 0.03 * Math.sin(t * 0.13 + i * 1.7)
      if (spec.faceCam) {
        ring.rotation.set(spec.rotX, spec.rotY, micro * 0.4)
      } else {
        ring.rotation.y = spec.rotY + (1 - inW) * 0.95 * spec.dir + micro * spec.dir
        ring.rotation.x = spec.rotX + (1 - inW) * 0.55 * (spec.rotX === 0 ? 1 : 0.35) * (i % 2 === 0 ? 1 : -1)
      }
      mat.uniforms.uTime.value = t
      mat.uniforms.uIntensity.value = spec.op * inW * ellipseMaster * (1 + collapseE * 1.1)
    })
    const nodeW = ellipseMaster
    for (const n of this.nodeSprites) {
      const spec = RING_SPECS[n.ring]
      const th = n.spec.offset + t * n.spec.speed
      const v = new THREE.Vector3(spec.rx * Math.cos(th), spec.rz * Math.sin(th), 0)
      const appear = spec.appear
      const reForm = sm(t, 7.62 + (n.ring % 6) * 0.07, 8.72 + (n.ring % 6) * 0.07)
      const inW = Math.max(sm(t, appear, appear + 0.95), reForm) * fade
      if (inW <= 0.001) {
        n.sprite.visible = false
        continue
      }
      const ring = this.ringMeshes[n.ring]
      v.applyEuler(ring.rotation).multiplyScalar(ring.scale.x)
      n.sprite.visible = true
      n.sprite.position.copy(v)
      n.mat.opacity = nodeW * inW * (0.75 + 0.25 * Math.sin(t * 2.2 + n.spec.offset * 5))
    }

    /* wire sphere + dust — the mesh depth arrives with phase 04 "depth & perspective" */
    const meshW = Math.max(sm(t, 3.0, 4.3) * (1 - hid), sm(t, 8.0, 9.2)) * fade
    const wireW = 0.024 * meshW * (1 - collapseE * 0.85)
    this.wireSphere.visible = wireW > 0.002
    this.wireMat.opacity = wireW
    this.wireSphere.rotation.y += dt * 0.02
    this.dustMat.opacity = 0.35 * Math.max(sm(t, 3.2, 4.4) * (1 - hid), sm(t, 8.1, 9.2)) * fade * (1 - collapseE * 0.7)
    this.dust.rotation.y += dt * 0.016

    /* iris */
    this.irisMat.uniforms.uTime.value = t
    this.irisMat.uniforms.uOpen.value = eyeW
    this.irisMat.uniforms.uSwirl.value = 0.15 + swirlPulse + collapseE * 5.0
    this.irisMat.uniforms.uBoost.value = eyeW * (1.12 + collapseE * 1.0)
    const irisScale = (0.62 + 0.38 * easeOutCubic(eyeW)) * (1 - 0.82 * collapseS)
    this.iris.scale.setScalar(Math.max(irisScale, 0.001))
    this.iris.quaternion.copy(this.camera.quaternion)
    this.iris.visible = eyeW > 0.001
    this.pupilMat.uniforms.uOpen.value = eyeW
    this.pupil.scale.setScalar(Math.max(irisScale, 0.001))
    this.pupil.quaternion.copy(this.camera.quaternion)
    this.pupil.visible = eyeW > 0.001
    this.halo.visible = eyeW > 0.001 || pointW > 0.001

    /* camera */
    this.mx += (this.tmx - this.mx) * Math.min(dt * 3, 1)
    this.my += (this.tmy - this.my) * Math.min(dt * 3, 1)
    const aspect = this.camera.aspect
    const baseZ = 7.8 + Math.max(0, 1.45 - aspect) * 2.2
    /* cinematic camera — every phase gets its own framing so the sequence
       reads as a progression, never as a repeating cycle */
    const dolly = easeInOutCubic(sm(t, 0.55, 4.2))       // 01-04  reveal the world
    const pushEye = easeInOutCubic(sm(t, 4.2, 5.8))      // 05     lean into the eye
    const dive = easeInOutCubic(sm(t, 5.8, 6.72))        // 06     fall into collapse
    const reset = easeOutCubic(sm(t, 6.86, 7.6))         // 07     whip back out
    const idle = sm(t, 8.8, 11)
    const zStage = 5.4 + (baseZ - 5.4) * dolly - 1.0 * pushEye - 2.1 * dive
    const camZ = zStage + (baseZ - zStage) * reset
    const yStage = 0.5 + 0.65 * dolly - 0.3 * pushEye - 0.45 * dive
    const camY = yStage + (1.15 - yStage) * reset
    const lyStage = -0.4 - 0.15 * dolly + 0.2 * pushEye - 0.25 * dive
    const lookY = lyStage + (-0.4 - lyStage) * reset
    const drift = sm(t, 1.4, 3.2) * (1 - sm(t, 5.6, 6.6))
    this.camera.position.set(
      this.mx * 0.3 + Math.sin(t * 0.11) * 0.35 * drift + Math.sin(t * 0.043) * 0.06 * idle,
      camY + this.my * 0.2 + Math.sin(t * 0.05) * 0.05 * idle,
      camZ
    )
    this.camera.lookAt(0, lookY, 0)
  }
}
