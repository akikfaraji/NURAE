/**
 * NURAE — procedural sprite textures (no external assets)
 * Generated once on an offscreen 2D canvas, uploaded as CanvasTexture.
 */
import * as THREE from 'three'

/** soft radial glow (stars, halos, node dots) */
export function makeGlowTexture(size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.18, 'rgba(230,240,255,0.9)')
  g.addColorStop(0.42, 'rgba(150,180,255,0.38)')
  g.addColorStop(0.75, 'rgba(80,110,255,0.10)')
  g.addColorStop(1, 'rgba(0,0,40,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * stellar flare — bright core + long horizontal / vertical streaks
 * used for the INITIAL POINT and the pupil star
 */
export function makeFlareTexture(size = 512): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const m = size / 2
  ctx.globalCompositeOperation = 'lighter'

  // wide horizontal streak
  let g = ctx.createLinearGradient(0, m, size, m)
  g.addColorStop(0, 'rgba(90,130,255,0)')
  g.addColorStop(0.5, 'rgba(190,215,255,0.85)')
  g.addColorStop(1, 'rgba(90,130,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, m - size * 0.012, size, size * 0.024)

  // wide vertical streak
  g = ctx.createLinearGradient(m, 0, m, size)
  g.addColorStop(0, 'rgba(90,130,255,0)')
  g.addColorStop(0.5, 'rgba(190,215,255,0.85)')
  g.addColorStop(1, 'rgba(90,130,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(m - size * 0.012, 0, size * 0.024, size)

  // soft inner halo
  const halo = ctx.createRadialGradient(m, m, 0, m, m, size * 0.5)
  halo.addColorStop(0, 'rgba(210,225,255,0.55)')
  halo.addColorStop(0.25, 'rgba(120,160,255,0.22)')
  halo.addColorStop(0.6, 'rgba(60,90,255,0.07)')
  halo.addColorStop(1, 'rgba(0,0,40,0)')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, size, size)

  // hot core
  const core = ctx.createRadialGradient(m, m, 0, m, m, size * 0.08)
  core.addColorStop(0, 'rgba(255,255,255,1)')
  core.addColorStop(0.5, 'rgba(220,235,255,0.9)')
  core.addColorStop(1, 'rgba(160,190,255,0)')
  ctx.fillStyle = core
  ctx.fillRect(0, 0, size, size)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
