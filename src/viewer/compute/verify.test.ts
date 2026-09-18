import { describe, it, expect } from 'vitest'
import { compareResults } from './verify'
import { octEncode } from './cpu/normals'

const PZ = octEncode([0, 0, 1])
const pack = (bytes: number[]) => { const out = new Uint32Array(Math.ceil(bytes.length / 4)); bytes.forEach((b, i) => { out[i >> 2] |= b << ((i & 3) * 8) }); return out }

describe('compareResults', () => {
  it('identical inputs → 0°, 0 MAE', () => {
    const n = 5, nrm = new Uint32Array(n).fill(octEncode([0.6, 0, 0.8])), ao = [255, 128, 0, 64, 200]
    const r = compareResults(nrm, pack(ao), nrm, new Uint8Array(ao), n)
    expect(r.n).toBe(n); expect(r.aoMae).toBe(0); expect(r.nonFinite).toBe(0); expect(r.degenerate).toBe(0)
    expect(r.medianDeg).toBeLessThan(0.01); expect(r.maxDeg).toBeLessThan(0.01)   // acos(|a·a|) on f32-normalised vectors is not exactly 0
  })
  it('median / max angle, sign-insensitive; AO MAE in [0,1]; counts +Z degenerates', () => {
    const a = [octEncode([1, 0, 0]), octEncode([0, 1, 0]), PZ, octEncode([0, 0, 1])]
    const b = [octEncode([-1, 0, 0]), octEncode([Math.SQRT1_2, Math.SQRT1_2, 0]), PZ, octEncode([0, 0, 1])]
    const r = compareResults(new Uint32Array(a), pack([255, 255, 255, 255]), new Uint32Array(b), new Uint8Array([255, 0, 255, 255]), 4)
    expect(r.maxDeg).toBeCloseTo(45, 1)          // flipped vector counts as 0°; oct 16-bit quantisation ≈ 0.003°
    expect(r.medianDeg).toBeLessThan(0.01)       // sorted angles 0, 0, 0, 45 → median of middle two = 0
    expect(r.aoMae).toBeCloseTo(0.25, 6)
    expect(r.degenerate).toBe(2)
  })
})
