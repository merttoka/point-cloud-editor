import { pointInPolygon, polyBounds } from './lasso'

export type Mat4 = Float32Array | number[]   // column-major, THREE.Matrix4.elements
type V3 = [number, number, number]

// CPU mirror of the kernel prologue: clip = viewProj * (p, 1); screen px = ((ndc.x*0.5+0.5)*w, (0.5-ndc.y*0.5)*h); depth = clip.z / clip.w.
export function projectPoint(x: number, y: number, z: number, m: Mat4, w: number, h: number): [number, number, number] | null {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  if (cw <= 0) return null
  const depth = cz / cw
  if (depth < 0 || depth > 1) return null
  return [(cx / cw * 0.5 + 0.5) * w, (0.5 - cy / cw * 0.5) * h, depth]
}

export function decodeWorld(words: Uint32Array, i: number, dqScale: V3, dqMin: V3): V3 {
  const w0 = words[i * 2], w1 = words[i * 2 + 1]
  return [(w0 & 0xffff) * dqScale[0] + dqMin[0], (w0 >>> 16) * dqScale[1] + dqMin[1], (w1 & 0xffff) * dqScale[2] + dqMin[2]]
}

// radiusPx(i, depth): the caller supplies the attenuated size (needs the view matrix) or a constant.
export function cpuPick(words: Uint32Array, n: number, dqScale: V3, dqMin: V3, viewProj: Mat4, w: number, h: number,
  cx: number, cy: number, visible: (i: number) => boolean, radiusPx: (i: number, depth: number) => number): number | null {
  let best = -1, bestDepth = Infinity
  for (let i = 0; i < n; i++) {
    if (!visible(i)) continue
    const [x, y, z] = decodeWorld(words, i, dqScale, dqMin)
    const s = projectPoint(x, y, z, viewProj, w, h)
    if (!s) continue
    const r = radiusPx(i, s[2])
    if ((s[0] - cx) ** 2 + (s[1] - cy) ** 2 > r * r) continue
    if (s[2] < bestDepth) { bestDepth = s[2]; best = i }
  }
  return best < 0 ? null : best
}

export function cpuLasso(words: Uint32Array, n: number, dqScale: V3, dqMin: V3, viewProj: Mat4, w: number, h: number,
  poly: Float32Array, count: number, visible: (i: number) => boolean): Uint32Array {
  const [minX, minY, maxX, maxY] = polyBounds(poly, count)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (!visible(i)) continue
    const [x, y, z] = decodeWorld(words, i, dqScale, dqMin)
    const s = projectPoint(x, y, z, viewProj, w, h)
    if (!s || s[0] < minX || s[0] > maxX || s[1] < minY || s[1] > maxY) continue
    if (pointInPolygon(s[0], s[1], poly, count)) out.push(i)
  }
  return Uint32Array.from(out)
}
