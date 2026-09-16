/**
 * NURAE — WebGL animation engine (v3 — "Reality is being resolved")
 *
 * A fixed vertical measurement axis stands in an infinite dark field. Fine
 * restless marks drift at five parallax depths around it (perception), stream
 * outward past the viewer while the central point never grows (infinite
 * approach), lock into a symmetric polar instrument as one measurement wave
 * sweeps out from the axis (resolution), dive into the axis (collapse), and
 * the surviving point becomes the identity (NURAE).
 *
 * Motion policy: the camera never zooms — all depth is layered parallax.
 * The scene is a pure function of the timeline t (flow displacement is
 * re-integrated on seek), so verification frames are deterministic.
 *
 * Same public contract as v2: constructor(canvas, {onPhase, onTick}),
 * start / restart / seek / dispose, LOOP_END export, __nuraeT/__nuraeFreeze/
 * __nuraeSeek debug hooks, ?static frozen-hold opt-in, dt cap 0.5s,
 * DPR 1.8 desktop / 1.5 small-viewport pairing on renderer AND composer.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { PHASES, T, sm, bell, clamp01, easeOutCubic, easeInOutCubic, easeInCubic } from './phases'
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

/** total loop length — storyboard (9.3s) + NURAE hold + master fade seam */
export const LOOP_END = 12.0

/** READY-hold ambient window for the ?static opt-in (inside the seam fade) */
const STATIC_HOLD_AT = 10.0
const STATIC_HOLD_SPAN = 1.1

/** depth layers — far → near; flow multiplier = parallax depth cue */
interface PlaneSpec {
  z: number
  scale: number
  flowMul: number
  sizeMul: number
  op: number
  seed: number
  inAt: number
  rotSpeed: number
}

const PLANES: PlaneSpec[] = [
  { z: -2.6, scale: 11.6, flowMul: 0.16, sizeMul: 0.72, op: 0.60, seed: 3.1, inAt: 1.15, rotSpeed: 0.008 },
  { z: -1.4, scale: 10.2, flowMul: 0.30, sizeMul: 0.85, op: 0.70, seed: 7.7, inAt: 1.55, rotSpeed: -0.011 },
  { z: -0.2, scale: 9.0, flowMul: 0.52, sizeMul: 1.0, op: 0.82, seed: 13.3, inAt: 1.95, rotSpeed: 0.014 },
  { z: 0.9, scale: 8.0, flowMul: 0.80, sizeMul: 1.12, op: 0.70, seed: 19.9, inAt: 2.35, rotSpeed: -0.018 },
  { z: 1.8, scale: 7.2, flowMul: 1.15, sizeMul: 1.22, op: 0.55, seed: 27.1, inAt: 2.75, rotSpeed: 0.023 },
]

/** field outer radius per plane (world units) — inside the plane half-size */
const FIELD_MAX_R = 4.15

/** micro-saccade schedule (s) — the gaze re-fixates, then stabilises forever */
const SACCADES = [1.35, 2.05, 2.65, 3.25, 3.8, 4.3, 4.75, 5.15, 5.5, 5.8, 6.05]
const SACCADE_AMP = 0.05

const frac = (x: number) => x - Math.floor(x)

/** outward flow speed (world units / s) — pure function of t */
const flowSpeed = (t: number) => {
  const base = 0.055
  const ramp = 1.265 * easeInOutCubic(sm(t, T.flowRamp[0], T.flowRamp[1]))
  const stop = 1 - sm(t, T.flowStop[0], T.flowStop[1])
  return (base + ramp) * stop
}

/** deterministic flow displacement — re-integrated on seek, advanced per frame */
const integrateFlow = (t: number) => {
  let d = 0
  const step = 1 / 30
  for (let u = step; u <= t; u += step) d += flowSpeed(u) * step
  return d
}

/** micro-saccade offset of the whole field — pure function of t (seek-safe) */
const saccade = (t: number) => {
  let k = -1
  for (let i = 0; i < SACCADES.length; i++) if (t >= SACCADES[i]) k = i
  if (k < 0) return { x: 0, y: 0 }
  const decay = Math.exp(-(t - SACCADES[k]) * 2.1)
  const h1 = frac(Math.sin((k + 1) * 127.1) * 43758.5453)
  const h2 = frac(Math.sin((k + 1) * 269.7) * 12543.2171)
  return { x: (h1 - 0.5) * 2 * SACCADE_AMP * decay, y: (h2 - 0.5) * 1.4 * SACCADE_AMP * decay }
}

export class NuraeEngine {
  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private composer!: EffectComposer
  private bloom!: UnrealBloomPass

  private starMat!: THREE.PointsMaterial
  private fieldGroup = new THREE.Group()
  private planeMats: THREE.ShaderMaterial[] = []
  private particleMats: THREE.PointsMaterial[] = []
  private particleGroups: THREE.Points[] = []

  private dot!: THREE.Sprite
  private coreGlow!: THREE.Sprite
  private halo!: THREE.Sprite
  private flare!: THREE.Sprite
  private axisMat!: THREE.ShaderMaterial
  private axis!: THREE.Mesh
  private axisDots: THREE.Sprite[] = []
  private pulseMat!: THREE.ShaderMaterial
  private lockMat!: THREE.ShaderMaterial
  private clickMat!: THREE.ShaderMaterial

  private glowTex!: THREE.CanvasTexture
  private flareTex!: THREE.CanvasTexture

  private raf = 0
  private lastNow = 0
  private t = 0
  private phaseIdx = -1
  private flow = 0
  private mx = 0
  private my = 0
  private tmx = 0
  private tmy = 0
  private clickAt = -10
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
    // Motion policy: ALWAYS play the full six-beat sequence. prefers-reduced-motion
    // must never freeze the loader (many Android phones report it permanently and
    // the loader looked stuck on one frame). ?static is the only frozen opt-in.
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
    this.camera.position.set(0, 0, 7.8)
    this.camera.lookAt(0, 0, 0)

    this.glowTex = makeGlowTexture()
    this.flareTex = makeFlareTexture()

    this.buildStars()
    this.buildPoint()
    this.buildAxis()
    this.buildField()
    this.buildWaves()

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.26, 0.35, 0.72)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.resize()
    window.addEventListener('resize', this.resize)
    window.addEventListener('pointermove', this.onPointer)
    window.addEventListener('pointerdown', this.onPointerDown)

    this.flow = integrateFlow(this.staticHold ? STATIC_HOLD_AT : 0)
    if (this.staticHold) this.t = STATIC_HOLD_AT
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
    this.t = ((t % LOOP_END) + LOOP_END) % LOOP_END
    this.phaseIdx = -1
    this.flow = integrateFlow(this.t)
    this.clickAt = -10
    this.cb.onPhase(this.phaseAt(this.t))
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('pointermove', this.onPointer)
    window.removeEventListener('pointerdown', this.onPointerDown)
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

  private phaseAt(t: number) {
    const idx = PHASES.findIndex((p) => t >= p.start && t < p.end)
    return idx === -1 ? PHASES.length - 1 : idx
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
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

  private onPointerDown = () => {
    // one precise ripple — the system registers the touch (§6, optional layer)
    this.clickAt = this.t
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
        this.t = STATIC_HOLD_AT + (this.t - STATIC_HOLD_AT + dt) % STATIC_HOLD_SPAN
        this.flow = integrateFlow(this.t)
      } else {
        this.t += dt
        if (this.t >= LOOP_END) {
          // master fade seam — the wrap happens while the frame is black;
          // flow is re-derived so the new cycle is state-identical to a fresh one
          this.t -= LOOP_END
          this.flow = integrateFlow(this.t)
        }
        this.flow += flowSpeed(this.t) * dt
      }
    }
    this.update(this.t, dt)
    this.composer.render()

    const t = this.t
    const idx = this.phaseAt(t)
    if (idx !== this.phaseIdx) {
      this.phaseIdx = idx
      this.cb.onPhase(idx)
    }
    const fade = sm(t, 0.0, 0.45) * (1 - sm(t, T.fadeOut[0], T.fadeOut[1]))
    this.cb.onTick({
      t,
      flash: Math.min(1, bell(t, T.flashAt, 0.045) * 0.2),
      readyW: sm(t, T.ready, T.readyFull) * fade,
      progress: clamp01(t / T.collapseEnd),
      fade,
    })
    ;(window as unknown as Record<string, unknown>).__nuraeT = t
    ;(window as unknown as Record<string, unknown>).__nuraeSeek = (tt: number) => this.seek(tt)
    ;(window as unknown as Record<string, unknown>).__nuraeRestart = () => this.restart()
    ;(window as unknown as Record<string, unknown>).__nuraeComposer = this.composer
    this.raf = requestAnimationFrame(this.loop)
  }

  /* ------------------------------------------------------------ */

  /** sparse, tiny, distant — infinite space, not a starfield */
  private buildStars() {
    const count = 130
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = 14 + Math.random() * 16
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      pos[i * 3 + 1] = r * Math.cos(ph)
      pos[i * 3 + 2] = -8 - Math.random() * 14
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.starMat = new THREE.PointsMaterial({
      size: 0.06,
      map: this.glowTex,
      color: 0xb9c9ee,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    this.scene.add(new THREE.Points(geo, this.starMat))
  }

  /** the point — microscopic, invariant, survivor */
  private buildPoint() {
    const mk = (tex: THREE.Texture, scale: number) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const s = new THREE.Sprite(mat)
      s.scale.setScalar(scale)
      this.scene.add(s)
      return s
    }
    this.halo = mk(this.glowTex, 3.0)
    ;(this.halo.material as THREE.SpriteMaterial).color = new THREE.Color(0x2c55e8)
    this.coreGlow = mk(this.glowTex, 0.9)
    this.dot = mk(this.glowTex, 0.155)
    this.flare = mk(this.flareTex, 0.5)
  }

  /** the vertical measurement axis — ticks, reading sweep, vanishing act */
  private buildAxis() {
    this.axisMat = new THREE.ShaderMaterial({
      vertexShader: SHADERS.QUAD_VERT,
      fragmentShader: SHADERS.AXIS_FRAG,
      uniforms: {
        uGrow: { value: 0 },
        uIntensity: { value: 0 },
        uClean: { value: 0 },
        uReadY: { value: 10 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.axis = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 11.6), this.axisMat)
    this.axis.position.z = 0.02
    this.scene.add(this.axis)

    // the two last readings — glide into the point during collapse
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
      s.scale.setScalar(0.11)
      s.position.z = 0.03
      this.scene.add(s)
      this.axisDots.push(s)
    }
  }

  /** five depth layers of fine marks + sparse particles — the observable world */
  private buildField() {
    this.scene.add(this.fieldGroup)

    PLANES.forEach((spec) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHADERS.QUAD_VERT,
        fragmentShader: SHADERS.FIELD_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uFlow: { value: 0 },
          uLockR: { value: 0 },
          uChaos: { value: 1 },
          uMaxR: { value: FIELD_MAX_R },
          uScale: { value: spec.scale / 2 },
          uSizeMul: { value: spec.sizeMul },
          uSeed: { value: spec.seed },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.scale, spec.scale), mat)
      mesh.position.z = spec.z
      mesh.frustumCulled = false
      this.fieldGroup.add(mesh)
      this.planeMats.push(mat)
    })

    // sparse particles at mixed depths — individuals, not dust
    const makeParticles = (count: number, size: number, zMin: number, zMax: number, seed: number) => {
      const pos = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const r = 0.7 + Math.pow(frac(Math.sin((i + seed) * 12.9898) * 43758.5453), 0.8) * (FIELD_MAX_R - 0.9)
        const a = frac(Math.sin((i + seed) * 78.233) * 127.531) * Math.PI * 2
        pos[i * 3] = Math.cos(a) * r
        pos[i * 3 + 1] = Math.sin(a) * r
        pos[i * 3 + 2] = zMin + (i / count) * (zMax - zMin)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const mat = new THREE.PointsMaterial({
        size,
        map: this.glowTex,
        color: 0xcfdfff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      const pts = new THREE.Points(geo, mat)
      this.fieldGroup.add(pts)
      this.particleMats.push(mat)
      this.particleGroups.push(pts)
    }
    makeParticles(22, 0.05, 0.2, 2.0, 1.7)
    makeParticles(20, 0.034, -2.6, -0.2, 9.2)
  }

  /** measurement waves — perception pulse, resolution lock, click ripple */
  private buildWaves() {
    const mk = (seed: number) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHADERS.QUAD_VERT,
        fragmentShader: SHADERS.SWEEP_FRAG,
        uniforms: {
          uR: { value: 0.2 },
          uScale: { value: 5.8 },
          uIntensity: { value: 0 },
          uSeed: { value: seed },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(11.6, 11.6), mat)
      mesh.visible = false
      mesh.position.z = 0.015
      mesh.frustumCulled = false
      this.scene.add(mesh)
      return { mat, mesh }
    }
    const pulse = mk(2.3)
    this.pulseMat = pulse.mat
    const lock = mk(5.9)
    this.lockMat = lock.mat
    const click = mk(8.1)
    this.clickMat = click.mat
    this.waveMeshes = [pulse.mesh, lock.mesh, click.mesh]
  }

  private waveMeshes: THREE.Mesh[] = []

  /* ------------------------------------------------------------ */

  private update(t: number, dt: number) {
    const fade = sm(t, 0.0, 0.45) * (1 - sm(t, T.fadeOut[0], T.fadeOut[1]))

    /* global weights */
    const collapseE = easeInOutCubic(sm(t, T.collapse[0], T.collapse[1]))
    const lockGlobal = sm(t, T.lockWave[0], T.settle)
    const chaos = 1 - sm(t, T.lockWave[0], T.settle)
    const lockR = 0.25 + 6.35 * easeOutCubic(sm(t, T.lockWave[0], T.lockWave[1]))

    /* stars */
    this.starMat.opacity = 0.3 * fade * (0.85 + 0.15 * Math.sin(t * 0.7))

    /* the point — microscopic, invariant, survivor; dissolves INTO the wordmark */
    const pointW =
      sm(t, T.pointIn[0], T.pointIn[1]) * fade * (1 - sm(t, 9.62, 10.25))
    const wobble = 0.008 * Math.sin(t * 2.2) * (1 - lockGlobal)
    const survivorBlink = 0.2 * bell(t, 9.2, 0.16)
    ;(this.dot.material as THREE.SpriteMaterial).opacity = pointW * (1 + survivorBlink)
    this.dot.scale.setScalar((0.135 + wobble + survivorBlink * 0.2) * Math.max(1 - 0.3 * collapseE, 0.4))
    ;(this.coreGlow.material as THREE.SpriteMaterial).opacity = pointW * 0.6
    this.coreGlow.scale.setScalar(0.82 + wobble * 3 + survivorBlink * 1.4)
    ;(this.flare.material as THREE.SpriteMaterial).opacity = bell(t, 9.3, 0.09) * 0.5 * fade
    this.flare.scale.setScalar(0.42 + 0.1 * bell(t, 9.3, 0.09))
    ;(this.halo.material as THREE.SpriteMaterial).opacity =
      0.15 * sm(t, T.pointIn[0], T.pointIn[1]) * fade * (1 - sm(t, 9.62, 10.6)) * (1 - 0.5 * collapseE)
    this.halo.scale.setScalar(3.0 * (1 + 0.03 * Math.sin(t * 0.9)))

    /* the axis */
    const grow = sm(t, T.axisGrow[0], T.axisGrow[1])
    const vanishE = easeInCubic(sm(t, T.axisVanish[0], T.axisVanish[1]))
    this.axisMat.uniforms.uGrow.value = grow
    this.axisMat.uniforms.uClean.value = sm(t, 8.55, 9.1)
    const readProg = sm(t, T.lockWave[0], T.lockWave[1])
    this.axisMat.uniforms.uReadY.value = readProg > 0.001 && readProg < 0.999
      ? 0.85 - 1.7 * readProg
      : 10
    this.axisMat.uniforms.uIntensity.value =
      (0.85 + 0.45 * bell(t, T.axisPeak, 0.5)) * fade * (1 - sm(t, 9.24, 9.42))
    this.axis.scale.y = Math.max(1 - 0.988 * vanishE, 0.012)
    this.axis.visible = t < 9.42

    // the two last readings glide into the point
    const dotsW = bell(t, 8.95, 0.45) * fade * 0.7
    this.axisDots.forEach((d, i) => {
      const k = easeInOutCubic(sm(t, 8.7, 9.25))
      ;(d.material as THREE.SpriteMaterial).opacity = dotsW
      d.position.y = (i === 0 ? 1 : -1) * (2.6 - 2.6 * k)
    })

    /* the field — reveal, parallax flow, saccades, lock, collapse */
    const sacc = saccade(t)
    this.fieldGroup.position.x = sacc.x * fade
    this.fieldGroup.position.y = sacc.y * fade
    this.fieldGroup.scale.setScalar(Math.max(1 - 0.88 * collapseE, 0.001))

    const stopE = sm(t, T.flowStop[0], T.flowStop[1])
    const quant = (Math.PI * 2) / 48
    PLANES.forEach((spec, i) => {
      const mat = this.planeMats[i]
      const inW = sm(t, spec.inAt, spec.inAt + 0.8)
      mat.uniforms.uTime.value = t
      mat.uniforms.uFlow.value = this.flow * spec.flowMul
      mat.uniforms.uLockR.value = lockR
      mat.uniforms.uChaos.value = chaos
      mat.uniforms.uIntensity.value =
        spec.op * inW * fade * (1 - 0.94 * collapseE) * (1 - sm(t, 9.15, 9.32))
      // each plane eases to a canonical rotation as the instrument locks
      const rotFree = spec.rotSpeed * t * (1 - stopE)
      const rotLocked = Math.round(rotFree / quant) * quant
      const mesh = this.fieldGroup.children[i]
      mesh.rotation.z = rotFree + (rotLocked - rotFree) * lockGlobal
    })

    const partIn = sm(t, 1.5, 2.6)
    this.particleMats.forEach((mat) => {
      mat.opacity =
        (0.34 + 0.1 * Math.sin(t * 6.7) * (1 - lockGlobal)) * partIn * fade * (1 - 0.9 * collapseE)
    })
    this.particleGroups.forEach((pts, i) => {
      const rotFree = (i === 0 ? 0.021 : -0.016) * t * (1 - stopE)
      const quantP = (Math.PI * 2) / 24
      const rotLocked = Math.round(rotFree / quantP) * quantP
      pts.rotation.z = rotFree + (rotLocked - rotFree) * lockGlobal
    })

    /* measurement waves */
    // perception pulse — the first measurement (setup for the lock wave)
    const pulseK = easeOutCubic(sm(t, T.pulseAt, T.pulseAt + 1.3))
    this.pulseMat.uniforms.uR.value = 0.2 + 3.3 * pulseK
    this.pulseMat.uniforms.uIntensity.value =
      0.28 * fade * sm(t, T.pulseAt - 0.05, T.pulseAt + 0.15) * (1 - sm(t, T.pulseAt + 1.35, T.pulseAt + 1.75))
    // resolution lock wave
    this.lockMat.uniforms.uR.value = lockR
    this.lockMat.uniforms.uIntensity.value =
      0.5 * fade * sm(t, T.lockWave[0] - 0.03, T.lockWave[0] + 0.1) * (1 - sm(t, T.lockWave[1] - 0.05, T.lockWave[1] + 0.35))
    // click ripple — one precise circle, real-time
    const clickK = (t - this.clickAt) / 0.9
    if (clickK >= 0 && clickK < 1) {
      this.clickMat.uniforms.uR.value = 0.15 + 2.4 * easeOutCubic(clickK)
      this.clickMat.uniforms.uIntensity.value = 0.3 * (1 - clickK)
    } else {
      this.clickMat.uniforms.uIntensity.value = 0
    }
    this.waveMeshes.forEach((m) => {
      m.visible = (m === this.waveMeshes[2]
        ? this.clickMat.uniforms.uIntensity.value > 0.001
        : m === this.waveMeshes[0]
          ? this.pulseMat.uniforms.uIntensity.value > 0.001
          : this.lockMat.uniforms.uIntensity.value > 0.001)
    })

    /* camera — fixed frame, the world does the moving */
    this.mx += (this.tmx - this.mx) * Math.min(dt * 3, 1)
    this.my += (this.tmy - this.my) * Math.min(dt * 3, 1)
    const aspect = this.camera.aspect
    const camZ = 7.8 + Math.max(0, 1.45 - aspect) * 2.2
    const idle = sm(t, T.idle, T.idle + 2)
    this.camera.position.set(
      this.mx * 0.14 + Math.sin(t * 0.09) * 0.05 * (0.4 + 0.6 * idle),
      this.my * 0.1 + Math.cos(t * 0.07) * 0.03,
      camZ
    )
    this.camera.lookAt(0, 0, 0)
  }
}
