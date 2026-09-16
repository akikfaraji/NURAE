/**
 * NURAE — GLSL shader library (v2 — premium pass)
 * Custom shaders for the cosmic eye, orbital ribbon rings, SDF ripples,
 * light beam and nebula haze. All additive-blended, tuned for UnrealBloom.
 */

/** shared value-noise + fbm chunk */
const NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = rot * p * 2.03 + vec2(11.7, 9.2);
    a *= 0.5;
  }
  return v;
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
/*  RING — constant-width elliptical ribbon with travelling energy     */
/* ------------------------------------------------------------------ */

/**
 * Vertex: builds a constant-width ribbon along an ellipse.
 * aAngle  0..2PI along the path, aSide -1..1 across the width.
 * The ellipse (uRx, uRz) is evaluated in the shader so a single unit
 * geometry is shared by every ring; mesh transforms still apply.
 */
const RING_VERT = /* glsl */ `
attribute float aAngle;
attribute float aSide;
uniform float uRx;
uniform float uRz;
uniform float uWidth;
varying float vAngle;
varying float vSide;

void main() {
  vAngle = aAngle;
  vSide = aSide;
  vec2 c = vec2(uRx * cos(aAngle), uRz * sin(aAngle));
  vec2 tang = normalize(vec2(-uRz * sin(aAngle), uRx * cos(aAngle)));
  vec2 nrm = vec2(-tang.y, tang.x);
  vec3 p = vec3(c + nrm * (uWidth * aSide), 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

/**
 * Fragment: thin bright core + soft halo across the width; organic
 * brightness around the circumference (base line + travelling arc
 * clusters + fine shimmer) plus an optional comet head with tail.
 * All frequencies are integers so the pattern wraps seamlessly.
 */
const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;
uniform float uSegs;       // integer arc count around the ring
uniform float uSharp;      // arc sharpness
uniform float uSpeed;      // arc travel speed (signed)
uniform float uComet;      // 0 = off, >0 comet tail length factor
uniform float uCometSpeed; // comet angular speed (turns/sec, signed)
varying float vAngle;
varying float vSide;

const float TAU = 6.28318530718;

void main() {
  float across = 1.0 - abs(vSide);
  float core = pow(across, 5.0);
  float halo = pow(across, 1.7) * 0.45;

  float a = vAngle + uSeed;

  // organic base — every segment visible, some dimmer than others
  float base = 0.20 + 0.14 * (0.5 + 0.5 * sin(a * 3.0 + uSeed * 5.0))
             + 0.08 * (0.5 + 0.5 * sin(a * 8.0 - uSeed * 2.0));

  // travelling bright arc clusters
  float wave = 0.5 + 0.5 * sin(a * uSegs - uTime * uSpeed);
  float arcs = pow(wave, uSharp);

  // fine shimmer racing over the arcs
  float fine = pow(0.5 + 0.5 * sin(a * (uSegs * 4.0 + 7.0) + uTime * (uSpeed * 1.1 + 0.16) + uSeed * 3.0), 6.0) * 0.32;

  // comet head with exponential tail
  float head = fract(uTime * uCometSpeed + uSeed * 0.6180339);
  float d = fract(a / TAU - head);
  float comet = exp(-d * (26.0 - uComet * 14.0)) * step(0.01, uComet);

  float energy = base + arcs * 1.05 + fine + comet * 1.7;
  float alpha = (core * (0.5 + energy) + halo * energy) * uIntensity;

  vec3 blue  = vec3(0.38, 0.58, 1.00);
  vec3 white = vec3(0.90, 0.95, 1.00);
  vec3 col = mix(blue, white, clamp(arcs * 0.5 + comet * 0.7, 0.0, 1.0));

  gl_FragColor = vec4(col * alpha, alpha);
}
`

/* ------------------------------------------------------------------ */
/*  RIPPLE — SDF expansion circle with angular hotspots                */
/* ------------------------------------------------------------------ */

const RIPPLE_FRAG = /* glsl */ `
uniform float uR;          // current circle radius (world units)
uniform float uScale;      // quad half-size in world units
uniform float uIntensity;
uniform float uSeed;
uniform float uTime;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float rUV = length(p);
  float r = rUV * uScale;   // world-unit radius
  float d = r - uR;
  float line = exp(-d * d * 950.0);
  float glowL = exp(-abs(d) * 12.0) * 0.14;

  float ang = atan(p.y, p.x);
  float arcs = pow(0.5 + 0.5 * sin(ang * 4.0 + uSeed * 9.0 + uTime * 0.85), 3.0);
  float hot  = pow(0.5 + 0.5 * sin(ang * 2.0 - uSeed * 3.0 - uTime * 1.35), 8.0) * 0.85;

  float edgeFade = smoothstep(1.0, 0.9, rUV);
  float energy = 0.30 + arcs * 0.8 + hot;
  float alpha = (line * energy + glowL * (0.2 + arcs * 0.35)) * uIntensity * edgeFade;

  vec3 col = mix(vec3(0.36, 0.56, 1.0), vec3(0.92, 0.96, 1.0), clamp(hot * 0.8 + arcs * 0.35, 0.0, 1.0));
  gl_FragColor = vec4(col * alpha, alpha);
}
`

/* ------------------------------------------------------------------ */
/*  IRIS — the cosmic eye (v2: radial fibres + limbal ring)            */
/* ------------------------------------------------------------------ */

const IRIS_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOpen;      // 0..1 eye reveal
uniform float uSwirl;     // extra angular swirl (phase 05 / collapse)
uniform float uBoost;     // intensity boost (collapse flash build)
uniform float uSeed;
varying vec2 vUv;

${NOISE}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);

  // galaxy-style differential swirl — stronger near the core
  float swirl = uSwirl * pow(1.0 - smoothstep(0.0, 0.95, r), 1.6);
  float a = ang + swirl + uTime * 0.05;
  vec2 dir = vec2(cos(a), sin(a));

  // layered radial filaments — higher contrast
  float n1 = fbm(dir * 2.6 + r * 7.0 - uTime * 0.04 + uSeed);
  float n2 = fbm(dir * 6.5 + r * 15.0 + uTime * 0.07 + uSeed * 2.3);
  float fil = pow(smoothstep(0.40, 1.0, n1 * 0.72 + n2 * 0.48), 1.35);

  // thin radial fibre strands — fast variation in angle, slow in radius
  float fib1 = fbm(vec2(a * 5.0 + uSeed, r * 2.4 - uTime * 0.05));
  float fib2 = fbm(vec2(a * 11.0 - uSeed, r * 4.2 + uTime * 0.03));
  float fib = pow(smoothstep(0.42, 0.95, fib1 * 0.62 + fib2 * 0.48), 1.6);

  // radial masks
  float pupil   = smoothstep(0.38, 0.22, r);
  float band    = smoothstep(0.14, 0.34, r) * smoothstep(1.02, 0.70, r);
  float limbal  = smoothstep(0.05, 0.0, abs(r - 0.82));    // bright outer ring
  float ringIn  = smoothstep(0.028, 0.0, abs(r - 0.40));   // bright ring at pupil edge

  // colour ramp — deep navy -> electric blue -> cyan-white
  vec3 cDeep   = vec3(0.020, 0.060, 0.480);
  vec3 cBlue   = vec3(0.110, 0.320, 0.960);
  vec3 cCyan   = vec3(0.560, 0.760, 1.000);
  vec3 cPink   = vec3(0.960, 0.470, 0.880);
  vec3 cViolet = vec3(0.520, 0.330, 1.000);

  vec3 col = mix(cDeep, cBlue, fil);
  col = mix(col, cViolet, smoothstep(0.45, 0.85, r) * 0.12);
  col = mix(col, cCyan, pow(fil, 3.0) * smoothstep(0.22, 0.80, r) * 0.42);

  // fibre strands lift brightness
  col += cCyan * fib * band * 0.34;
  col += vec3(1.0) * pow(fib, 3.0) * band * 0.10;

  // pink / violet accents around the pupil and outer field
  float accent = pow(fbm(dir * 3.4 + r * 5.2 + uSeed * 3.1), 2.2);
  col += cPink * accent * smoothstep(0.18, 0.32, r) * smoothstep(0.64, 0.40, r) * 1.35;
  col += cViolet * accent * smoothstep(0.38, 0.78, r) * 0.9;

  // bright structures — limbal ring + inner ring
  col += cCyan * limbal * 0.6;
  col += mix(cPink, vec3(1.0), 0.6) * ringIn * 0.55;

  float alpha = (fil * band * 1.0 + fib * band * 0.65 + limbal * 0.55 + ringIn * 0.6) * uOpen;
  alpha *= (1.0 - pupil * 0.995);

  // subtle glow bleeding at the pupil edge
  float core = smoothstep(0.12, 0.06, r);
  col += vec3(0.72, 0.82, 1.0) * core * 0.12;
  alpha += core * 0.04 * uOpen;

  gl_FragColor = vec4(col * uBoost * 0.82, alpha);
}
`

/* ------------------------------------------------------------------ */
/*  BEAM — vertical light shaft with centre-out draw                   */
/* ------------------------------------------------------------------ */

const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGrow;      // 0..1 draw from centre outward
uniform float uIntensity;
varying vec2 vUv;

void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float y = abs(vUv.y - 0.5) * 2.0;

  float growMask = 1.0 - smoothstep(uGrow - 0.06, uGrow + 0.02, y);
  float core  = exp(-x * x * 170.0);
  float halo  = exp(-x * x * 12.0) * 0.22;
  float endFade = exp(-y * y * 2.1);
  float shimmer = 0.82 + 0.18 * sin(uTime * 1.1 + vUv.y * 24.0);

  vec3 col = mix(vec3(0.30, 0.52, 1.0), vec3(0.96, 0.98, 1.0), core);
  float a = (core + halo) * endFade * growMask * shimmer * uIntensity;
  gl_FragColor = vec4(col * a, a);
}
`

/* ------------------------------------------------------------------ */
/*  NEBULA — slow drifting haze planes                                 */
/* ------------------------------------------------------------------ */

const NEBULA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;
varying vec2 vUv;

${NOISE}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float n = fbm(p * 2.2 + uTime * 0.015 + uSeed);
  n = pow(smoothstep(0.25, 1.05, n), 1.6);
  float falloff = smoothstep(1.0, 0.15, r);
  vec3 col = mix(vec3(0.07, 0.16, 0.55), vec3(0.30, 0.45, 1.0), n);
  float a = n * falloff * uIntensity;
  gl_FragColor = vec4(col * a, a);
}
`

const PUPIL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uOpen;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = smoothstep(1.0, 0.80, r) * uOpen;
  gl_FragColor = vec4(vec3(0.0, 0.004, 0.015), a);
}
`

export const SHADERS = {
  QUAD_VERT,
  RING_VERT,
  RING_FRAG,
  RIPPLE_FRAG,
  IRIS_FRAG,
  BEAM_FRAG,
  NEBULA_FRAG,
  PUPIL_FRAG,
}
