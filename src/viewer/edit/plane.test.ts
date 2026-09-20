import { describe, it, expect } from 'vitest'
import { fitPlane, mulberry32, signedDistance, samplePoints } from './plane'

// Gaussian-ish noise via sum of uniforms (Irwin–Hall), deterministic.
function synthetic(seed: number, n: number, normal: [number, number, number], d: number, noise: number, outlierFrac: number) {
  const rnd = mulberry32(seed)
  const g = () => (rnd() + rnd() + rnd() + rnd() - 2) * Math.sqrt(3) * noise
  const [nx, ny, nz] = normal
  const pts = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    let x = (rnd() - 0.5) * 100, y = (rnd() - 0.5) * 100
    // solve nz*z = -d - nx*x - ny*y (normals in tests have nz != 0)
    let z = (-d - nx * x - ny * y) / nz + g()
    if (rnd() < outlierFrac) z += (rnd() - 0.5) * 60
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z
  }
  return pts
}
const deg = (a: [number, number, number], b: [number, number, number]) =>
  Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI

describe('fitPlane', () => {
  it('recovers a tilted plane under noise and 30% outliers within 1° / threshold', () => {
    const len = Math.hypot(0.3, -0.2, 1)
    const normal: [number, number, number] = [0.3 / len, -0.2 / len, 1 / len]
    const pts = synthetic(1, 4000, normal, -5, 0.05, 0.3)
    const p = fitPlane(pts, 4000, 0.2, { seed: 7 })!
    expect(p).not.toBeNull()
    expect(deg(p.normal, normal)).toBeLessThan(1)
    expect(Math.abs(p.d - -5 * Math.sign(p.normal[2] / normal[2]))).toBeLessThan(0.2)
    expect(p.inlierRatio).toBeGreaterThan(0.6)
  })
  it('returns null below 3 points', () => {
    expect(fitPlane(new Float32Array(6), 2, 1)).toBeNull()
  })
  it('returns null when every hypothesis is degenerate (collinear points)', () => {
    const pts = new Float32Array(30)
    for (let i = 0; i < 10; i++) { pts[i * 3] = i; pts[i * 3 + 1] = 2 * i; pts[i * 3 + 2] = -i }
    expect(fitPlane(pts, 10, 0.1, { seed: 3 })).toBeNull()
  })
  it('signedDistance is zero on the plane', () => {
    const p = { normal: [0, 0, 1] as [number, number, number], d: -2, inlierRatio: 1 }
    expect(signedDistance(p, 5, 5, 2)).toBeCloseTo(0)
    expect(signedDistance(p, 0, 0, 3)).toBeCloseTo(1)
  })
  it('samplePoints strides down to the cap', () => {
    const src = new Float32Array(30)
    for (let i = 0; i < 10; i++) src[i * 3] = i
    const s = samplePoints(src, 10, 4)
    expect(s.n).toBe(4)
    expect(Array.from(s.pts.filter((_, k) => k % 3 === 0))).toEqual([0, 2, 5, 7])
    expect(samplePoints(src, 10, 20).n).toBe(10)
  })
})
