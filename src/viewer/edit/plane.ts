import { smallestEigenvector } from '../compute/cpu/normals'

export interface Plane { normal: [number, number, number]; d: number; inlierRatio: number }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const signedDistance = (p: Plane, x: number, y: number, z: number) => p.normal[0] * x + p.normal[1] * y + p.normal[2] * z + p.d

// Uniform stride sample (index k → floor(k * n / cap)); the whole set when n <= cap.
export function samplePoints(src: Float32Array, n: number, cap: number): { pts: Float32Array; n: number } {
  if (n <= cap) return { pts: src, n }
  const pts = new Float32Array(cap * 3)
  for (let k = 0; k < cap; k++) {
    const i = Math.floor((k * n) / cap)
    pts[k * 3] = src[i * 3]; pts[k * 3 + 1] = src[i * 3 + 1]; pts[k * 3 + 2] = src[i * 3 + 2]
  }
  return { pts, n: cap }
}

function planeThrough(pts: Float32Array, a: number, b: number, c: number): Plane | null {
  const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2]
  const ux = pts[b * 3] - ax, uy = pts[b * 3 + 1] - ay, uz = pts[b * 3 + 2] - az
  const vx = pts[c * 3] - ax, vy = pts[c * 3 + 1] - ay, vz = pts[c * 3 + 2] - az
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  if (!(len > 1e-12)) return null
  nx /= len; ny /= len; nz /= len
  return { normal: [nx, ny, nz], d: -(nx * ax + ny * ay + nz * az), inlierRatio: 0 }
}

function countInliers(pts: Float32Array, n: number, p: Plane, t: number): number {
  let c = 0
  for (let i = 0; i < n; i++) if (Math.abs(signedDistance(p, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])) <= t) c++
  return c
}

// PCA over the inliers: normal = smallest eigenvector of the covariance, plane through the centroid.
function refine(pts: Float32Array, n: number, p: Plane, t: number): Plane {
  let cx = 0, cy = 0, cz = 0, m = 0
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (Math.abs(signedDistance(p, x, y, z)) > t) continue
    cx += x; cy += y; cz += z; m++
  }
  cx /= m; cy /= m; cz /= m
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (Math.abs(signedDistance(p, x, y, z)) > t) continue
    const dx = x - cx, dy = y - cy, dz = z - cz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  const e = smallestEigenvector([xx / m, xy / m, xz / m, xy / m, yy / m, yz / m, xz / m, yz / m, zz / m])
  if (!e) return { ...p, inlierRatio: m / n }
  // keep the RANSAC orientation so A/B sides are stable
  const flip = e[0] * p.normal[0] + e[1] * p.normal[1] + e[2] * p.normal[2] < 0 ? -1 : 1
  const normal: [number, number, number] = [e[0] * flip, e[1] * flip, e[2] * flip]
  return { normal, d: -(normal[0] * cx + normal[1] * cy + normal[2] * cz), inlierRatio: m / n }
}

// RANSAC (3-point hypotheses) then PCA refine. `pts` = xyz triples, `threshold` = inlier distance.
export function fitPlane(pts: Float32Array, n: number, threshold: number, opts: { iterations?: number; seed?: number } = {}): Plane | null {
  if (n < 3) return null
  const rnd = mulberry32(opts.seed ?? 1)
  const iters = opts.iterations ?? 200
  let best: Plane | null = null, bestCount = -1
  for (let k = 0; k < iters; k++) {
    const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n), c = Math.floor(rnd() * n)
    if (a === b || b === c || a === c) continue
    const p = planeThrough(pts, a, b, c)
    if (!p) continue
    const count = countInliers(pts, n, p, threshold)
    if (count > bestCount) { best = p; bestCount = count }
  }
  return best ? refine(pts, n, best, threshold) : null
}
