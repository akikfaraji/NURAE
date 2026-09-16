/**
 * NURAE — GLSL shader library (v3 — "Reality is being resolved")
 *
 * Four shaders, one idea:
 *  - FIELD  depth layers of fine restless marks (polar slots around the axis);
 *           outward flow = infinite approach, lock wave = resolution
 *  - AXIS   the vertical measurement axis — ruler ticks, reading sweep, vanishing
 *  - SWEEP  one thin measurement circle (perception pulse / lock wave / click ripple)
 *
 * All additive-blended, tuned for UnrealBloom with a high threshold so hairlines
 * stay crisp. No noise fields, no nebulae, no eyes — empty space is the design.
 */

/** deterministic per-element hash (one clean hash is all the field needs) */
const HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 271.13);
  p *= p + 71.7;
  p += dot(p, p + 137.31);
  return fract(p);
}
vec2 hash22(float p) {
  float a = hash11(p);
  float b = hash11(p + 19.19);
  return vec2(a, b);
}
`

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/* ------------------------------------------------------------------ */
/*  FIELD — fine marks in polar slots, radial flow, lock wave           */
/* ------------------------------------------------------------------ */

/**
 * The plane is centred on the axis (local 0,0 == the axis line).
 * Elements live in polar slots: i = radial band, j = angular slot.
 * uFlow advances every element outward (band wrap masked at the edges);
 * the lock wave (uLockR) snaps each element to its nearest ring/spoke,
 * removes its jitter, steadies its flicker and resolves violet → blue.
 */
const FIELD_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uFlow;      // accumulated radial displacement (world units)
uniform float uLockR;     // lock wave radius (world units; > uMaxR = all locked)
uniform float uChaos;     // global chaos amount 1 -> 0 across resolution
uniform float uMaxR;      // field outer radius (world units)
uniform float uScale;     // plane half-size in world units
uniform float uSizeMul;   // per-plane element size factor
uniform float uSeed;
varying vec2 vUv;

${HASH}

const float TAU = 6.28318530718;
const float BANDS  = 8.0;
const float SLOTS  = 26.0;

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uScale;
  float r = length(p);
  float ang = atan(p.y, p.x + 0.0001);

  float ringStep = uMaxR / BANDS;

  // ---- the one large arc per plane (hierarchy mark) ----
  // chaotic: a 2.4-rad arc drifting off its base angle — resolved: a full circle
  float arcR = uMaxR * (0.28 + 0.30 * hash11(uSeed));
  float arcA = fract(uSeed * 0.611) * TAU + uChaos * (hash11(uSeed + 4.4) - 0.5) * 2.0;
  float ad = mod(ang - arcA + TAU, TAU);
  float span = mix(2.4, TAU, 1.0 - uChaos);
  float arcMask = step(ad, span);
  float arcD = abs(r - arcR);
  float aa = fwidth(r) * 1.4 + 0.004;
  float arc = exp(-pow(arcD / aa, 2.0)) * arcMask * mix(0.30, 0.42, 1.0 - uChaos);

  float alpha = arc * uIntensity;

  // ---- two long horizontal hairlines (data rows) ----
  for (int k = 0; k < 2; k++) {
    float fh = hash11(uSeed + float(k) * 7.31);
    float ly = (fh - 0.5) * uScale * 1.15;
    // drifts slightly, then locks perfectly horizontal (it already is) + steady
    float lx = p.x + (fh - 0.5) * uChaos * 2.2;
    float dx = abs(p.y - ly);
    float lin = exp(-pow(dx / (aa * 1.1), 2.0));
    float lx0 = -uScale * 0.55 + fh * uScale * 0.3;
    float lxs = uScale * (0.5 + 0.4 * hash11(fh * 31.7));
    float inX = step(lx0, lx) * step(lx, lx0 + lxs);
    alpha += lin * inX * uIntensity * 0.16;
  }

  // ---- polar slot elements ----
  // flow is applied per element: erD = mod(er + uFlow, uMaxR) — marks stream
  // outward and wrap at the masked edges, so there is never a hole at the axis.
  // The fragment therefore searches the SOURCE bands around (r - uFlow).
  float F = uFlow;
  float srcR = mod(r - F, uMaxR);
  float band0 = floor(srcR / ringStep);
  float slot = floor((ang + TAU) / TAU * SLOTS);

  for (int b = -1; b <= 1; b++) {
    float bi = band0 + float(b);
    if (bi < 0.0 || bi > BANDS - 1.0) continue;
    float eId = bi * SLOTS + slot + uSeed * 13.0;
    vec2 h = hash22(eId);
    vec2 h2 = hash22(eId + 3.7);
    if (h.x > 0.70) continue;                 // ~70% of slots are empty — sparseness is the design

    // element base radius in its band, then outward flow displacement (wraps)
    float er = (bi + 0.18 + 0.64 * h.y) * ringStep;
    float erD = mod(er + F, uMaxR);
    float ea = (slot + 0.5) / SLOTS * TAU - TAU + (h2.x - 0.5) * (TAU / SLOTS) * 1.45;

    // lock: quantise radius to rings, angle to spokes, remove jitter
    float ringQ = (floor(erD / ringStep + 0.5) + 0.5) * ringStep;
    float spokeQ = (floor((ea + TAU) / TAU * SLOTS + 0.5)) / SLOTS * TAU - TAU;
    float lockE = 1.0 - smoothstep(uLockR - 0.10, uLockR + 0.14, erD);
    lockE = max(lockE, 1.0 - uChaos);
    float lr = mix(erD, ringQ, lockE);
    float la = mix(ea, spokeQ, lockE);

    vec2 ep = vec2(cos(la), sin(la)) * lr;

    // element type + size
    float type = h2.y;
    float esz = (0.05 + 0.10 * hash11(eId + 9.1)) * uSizeMul;

    // chaotic drift while unresolved
    vec2 drift = (hash22(eId + 5.3) - 0.5) * uChaos * (0.24 * uSizeMul);
    ep += drift * (1.0 - lockE);

    vec2 d2 = p - ep;
    float dd = length(d2);
    float e = 0.0;

    if (type < 0.46) {
      // hairline segment — tangent while locked, random angle while chaotic
      float la2 = mix(h.x * TAU, la + 1.5707963, lockE);
      vec2 dir = vec2(cos(la2), sin(la2));
      float along = dot(d2, dir);
      float across = dot(d2, vec2(-dir.y, dir.x));
      float halfL = esz * (1.2 + 1.6 * hash11(eId + 2.2));
      float seg = exp(-pow(across / (aa * 0.9), 2.0))
                * smoothstep(halfL, halfL * 0.55, abs(along));
      e = seg * 0.72;
    } else if (type < 0.68) {
      // tiny circle outline
      float cr = esz * 0.9;
      e = exp(-pow((dd - cr) / (aa * 1.1), 2.0)) * 0.52;
    } else if (type < 0.86) {
      // dot
      e = exp(-pow(dd / (aa * 1.3), 2.0)) * 0.7;
    } else {
      // measurement cross +
      vec2 q = abs(d2);
      float arm = esz * 1.1;
      float tk = exp(-pow(q.y / (aa * 0.9), 2.0)) * step(q.x, arm)
               + exp(-pow(q.x / (aa * 0.9), 2.0)) * step(q.y, arm);
      e = tk * 0.5;
    }

    // restless flicker pre-lock; steady, dimmer, whiter post-lock — the mark
    // yields to the lattice it now sits on
    float flick = 0.62 + 0.38 * sin(uTime * (2.0 + 3.0 * h.y) + h2.x * 41.0);
    e *= mix(flick, 0.5 + 0.05 * sin(uTime * 0.8 + h.x * 9.0), lockE);

    // colour: violet accents live only in the unresolved noise
    vec3 blue = vec3(0.40, 0.58, 1.00);
    vec3 white = vec3(0.90, 0.95, 1.00);
    vec3 violet = vec3(0.60, 0.44, 1.00);
    float isV = step(h.x, 0.055) * (1.0 - lockE);
    vec3 col = mix(mix(blue, white, step(0.90, h2.y)), violet, isV);
    col = mix(col, white, lockE * 0.55);

    alpha += e * uIntensity;
  }

  // clear zone around the axis + outer fade — the ruler never touches chaos
  float edge = smoothstep(0.34, 0.62, r) * smoothstep(uMaxR * 1.02, uMaxR * 0.84, r);

  // the resolved instrument itself: faint precise rings + spokes the marks sit on
  float lockAll = 1.0 - uChaos;
  if (lockAll > 0.001) {
    float ringD = (fract(r / ringStep + 0.5) - 0.5) * ringStep;
    float ring = exp(-pow(ringD / (aa * 1.7), 2.0)) * 0.105;
    float spokeW = TAU / SLOTS;
    float spokeD = (fract(ang / spokeW + 0.5) - 0.5) * spokeW * max(r, 0.4);
    float spoke = exp(-pow(spokeD / (aa * 1.7), 2.0)) * 0.052;
    alpha += (ring + spoke) * lockAll * uIntensity;
  }

  alpha *= edge;

  vec3 baseCol = vec3(0.52, 0.66, 1.0);
  gl_FragColor = vec4(baseCol * alpha, alpha);
}
`

/* ------------------------------------------------------------------ */
/*  AXIS — the vertical measurement axis (the signature)                */
/* ------------------------------------------------------------------ */

const AXIS_FRAG = /* glsl */ `
uniform float uGrow;      // 0..1 draw from centre outward
uniform float uIntensity;
uniform float uClean;     // 0..1 — ticks retract, line purifies
uniform float uReadY;     // reading sweep position (-1..1, off-axis = 10)
varying vec2 vUv;

${HASH}

void main() {
  float nx = abs(vUv.x - 0.5) * 2.0;   // across
  float ny = (vUv.y - 0.5) * 2.0;      // along, -1..1

  float k = mix(240.0, 460.0, uClean);
  float core = exp(-nx * nx * k);
  float glow = exp(-nx * nx * 13.0) * 0.15;

  // ruler ticks — deterministic hash sequence, perfectly static (the invariant)
  float tickN = 30.0;
  float tv = vUv.y * tickN;
  float cell = floor(tv);
  float f = fract(tv) - 0.5;
  float exists = step(0.34, hash11(cell + 0.7));
  float major = step(0.86, hash11(cell + 0.7));
  float tickLen = mix(0.055, 0.16, major);
  float tick = exp(-f * f * 620.0)
             * smoothstep(tickLen, tickLen * 0.5, nx)
             * exists * mix(0.5, 1.0, major);
  tick *= (1.0 - uClean);

  // reading sweep — the axis taking measurements during resolution
  float read = exp(-pow((ny - uReadY) * 2.4, 2.0)) * 0.55 * step(abs(uReadY), 1.5);

  // draw-on mask from the centre out, soft ends
  float growMask = 1.0 - smoothstep(uGrow - 0.05, uGrow + 0.01, abs(ny));
  float endFade = exp(-ny * ny * 2.0);

  float a = (core + glow + tick * 0.8) * growMask * endFade * uIntensity;
  a += read * core * growMask * endFade * 0.8;

  vec3 col = mix(vec3(0.42, 0.60, 1.00), vec3(0.95, 0.97, 1.00), core * 0.75 + read * 0.6);
  gl_FragColor = vec4(col * a, a);
}
`

/* ------------------------------------------------------------------ */
/*  SWEEP — one thin measurement circle                                 */
/* ------------------------------------------------------------------ */

const SWEEP_FRAG = /* glsl */ `
uniform float uR;         // circle radius (world units)
uniform float uScale;     // quad half-size (world units)
uniform float uIntensity;
uniform float uSeed;
varying vec2 vUv;

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uScale;
  float r = length(p);
  float d = r - uR;

  float aa = fwidth(r) * 1.2 + 0.004;
  float ring = exp(-pow(d / (aa * 2.2), 2.0));
  float trail = exp(-abs(d) * 2.6) * 0.055;

  // faint angular breathing — life, never a hotspot
  float ang = atan(p.y, p.x);
  float micro = 0.86 + 0.14 * sin(ang * 3.0 + uSeed * 7.0);

  float edgeFade = smoothstep(1.0, 0.92, length(vUv * 2.0 - 1.0));
  float a = (ring + trail) * micro * uIntensity * edgeFade;

  vec3 col = mix(vec3(0.93, 0.96, 1.0), vec3(0.45, 0.62, 1.0), 0.3);
  gl_FragColor = vec4(col * a, a);
}
`

export const SHADERS = {
  QUAD_VERT,
  FIELD_FRAG,
  AXIS_FRAG,
  SWEEP_FRAG,
}
