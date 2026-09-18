import { describe, it, expect } from 'vitest'
import { jacobiEigen, smallestEigenvector, octEncode, octDecode, normalAt, computeNormals } from './normals'
import { buildGrid } from './hash'

const angleDeg = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI

describe('jacobiEigen', () => {
  it('diagonal matrix: eigenvalues are the diagonal, vectors the axes', () => {
    const { values, vectors } = jacobiEigen([3, 0, 0, 0, 1, 0, 0, 0, 2])
    const sorted = [...values].sort((a, b) => a - b)
    expect(sorted[0]).toBeCloseTo(1, 10); expect(sorted[1]).toBeCloseTo(2, 10); expect(sorted[2]).toBeCloseTo(3, 10)
    const kMin = values.indexOf(sorted[0])
    expect(Math.abs(vectors[3 + kMin])).toBeCloseTo(1, 10)     // column kMin = ±(0,1,0)
  })
  it('known symmetric matrix', () => {
    const m = [2, 1, 0, 1, 2, 0, 0, 0, 3]                        // eigenvalues 1, 3, 3
    const { values, vectors } = jacobiEigen(m)
    const sorted = [...values].sort((a, b) => a - b)
    expect(sorted[0]).toBeCloseTo(1, 5); expect(sorted[1]).toBeCloseTo(3, 5); expect(sorted[2]).toBeCloseTo(3, 5)
    const k = values.indexOf(sorted[0])
    const v = [vectors[k], vectors[3 + k], vectors[6 + k]]
    expect(angleDeg(v, [1, -1, 0].map((x) => x / Math.SQRT2))).toBeLessThan(1e-3)
  })
})

describe('smallestEigenvector', () => {
  it('null when the two smallest eigenvalues coincide', () => {
    expect(smallestEigenvector([1, 0, 0, 0, 1, 0, 0, 0, 5])).toBeNull()
  })
  it('unit vector otherwise', () => {
    const v = smallestEigenvector([3, 0, 0, 0, 1, 0, 0, 0, 2])!
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
    expect(Math.abs(v[1])).toBeCloseTo(1, 10)
  })
})

describe('oct encode/decode', () => {
  it('round-trips unit vectors within 0.5°', () => {
    let seed = 3
    const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1 }
    let worst = 0
    for (let t = 0; t < 2000; t++) {
      const v = [r(), r(), r()]; const l = Math.hypot(...v); if (l < 1e-3) continue
      const n = v.map((x) => x / l) as [number, number, number]
      worst = Math.max(worst, angleDeg(n, octDecode(octEncode(n))))
    }
    expect(worst).toBeLessThan(0.5)
  })
  it('+Z encodes to the centre of the square', () => {
    expect(octEncode([0, 0, 1])).toBe((32768 | (32768 << 16)) >>> 0)
  })
})

describe('normalAt / computeNormals', () => {
  function plane(n: number, tilt: [number, number, number]) {
    // points on a plane through the origin with normal `tilt` (unit), jittered along the plane only
    const [a, b, c] = tilt
    const u = Math.abs(a) < 0.9 ? [0, c, -b] : [-c, 0, a]       // a vector orthogonal to tilt
    const ul = Math.hypot(...u); const U = u.map((x) => x / ul)
    const V = [b * U[2] - c * U[1], c * U[0] - a * U[2], a * U[1] - b * U[0]]
    const pos = new Float32Array(n * 3)
    let s = 11; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    for (let i = 0; i < n; i++) {
      const x = r() * 20, y = r() * 20
      pos[i * 3] = 30 + x * U[0] + y * V[0]; pos[i * 3 + 1] = 30 + x * U[1] + y * V[1]; pos[i * 3 + 2] = 30 + x * U[2] + y * V[2]
    }
    return pos
  }
  it('recovers a tilted plane normal within 1°, oriented toward +Z', () => {
    const tilt: [number, number, number] = [0.3, -0.2, 0.9327379053088815]   // unit
    const n = 4000, pos = plane(n, tilt), g = buildGrid(pos, n, 1.5, 1024)
    let worst = 0, flipped = 0
    for (let i = 0; i < n; i += 97) { const v = normalAt(g, pos, i); worst = Math.max(worst, angleDeg(v, tilt)); if (v[2] < 0) flipped++ }
    expect(worst).toBeLessThan(1)
    expect(flipped).toBe(0)
  })
  it('noisy vertical facade: normal is horizontal within 10° (radius PCA, no K cap)', () => {
    // wall x = 20 ± 0.15 m depth noise, 3 m × 3 m patch at 1 pt / 0.25 m, plus a roof line at z = 33 leaking in
    const pts: number[] = []
    let s = 21; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    for (let y = 0; y < 12; y++) for (let z = 0; z < 12; z++) pts.push(20 + (r() - 0.5) * 0.3, 10 + y * 0.25, 30 + z * 0.25)
    for (let y = 0; y < 12; y++) pts.push(19.5 + r() * 0.5, 10 + y * 0.25, 33.1)
    const pos = new Float32Array(pts), n = pos.length / 3, g = buildGrid(pos, n, 1.0, 1024)
    const v = normalAt(g, pos, 12 * 6 + 6)           // mid-wall point
    expect(Math.abs(v[2])).toBeLessThan(Math.sin(10 * Math.PI / 180))
  })
  it('isolated point → +Z', () => {
    const pos = new Float32Array([5, 5, 5, 50, 50, 50, 50.1, 50, 50])
    const g = buildGrid(pos, 3, 1, 1024)
    expect(normalAt(g, pos, 0)).toEqual([0, 0, 1])
    const out = computeNormals(g, pos, 3)
    expect(out.length).toBe(3)
    expect(angleDeg(octDecode(out[0]), [0, 0, 1])).toBeLessThan(0.01)
  })
})
