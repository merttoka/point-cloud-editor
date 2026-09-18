import { describe, it, expect } from 'vitest'
import { edlObscurance, edlShade, EDL_TAPS } from './edl'

const NEAR = 1.6, FAR = 16000
const ring = (v: number) => Array.from({ length: EDL_TAPS }, () => v)

describe('edlObscurance', () => {
  it('is zero on a flat plane', () => {
    expect(edlObscurance(100, ring(100), NEAR, FAR)).toBe(0)
  })
  it('is positive when neighbours are closer (step edge, centre on the far side)', () => {
    const taps = [50, 50, 50, 50, 100, 100, 100, 100]
    const obs = edlObscurance(100, taps, NEAR, FAR)
    expect(obs).toBeCloseTo((4 * Math.log2(100 / 50)) / EDL_TAPS, 10)   // 0.5
  })
  it('is zero when neighbours are farther (centre on the near side)', () => {
    expect(edlObscurance(50, ring(100), NEAR, FAR)).toBe(0)
  })
  it('is invariant to tap order', () => {
    const a = [50, 60, 70, 80, 90, 100, 110, 120]
    const b = [...a].reverse()
    expect(edlObscurance(100, a, NEAR, FAR)).toBeCloseTo(edlObscurance(100, b, NEAR, FAR), 12)
  })
  it('background centre (>= far*0.999) yields zero', () => {
    expect(edlObscurance(FAR, ring(10), NEAR, FAR)).toBe(0)
    expect(edlObscurance(FAR * 0.999, ring(10), NEAR, FAR)).toBe(0)
  })
  it('background taps contribute nothing to a foreground centre (no silhouette halo)', () => {
    expect(edlObscurance(100, ring(FAR), NEAR, FAR)).toBe(0)
    const mixed = [FAR, FAR, FAR, FAR, 50, 50, 50, 50]
    expect(edlObscurance(100, mixed, NEAR, FAR)).toBeCloseTo((4 * 1) / EDL_TAPS, 10)
  })
  it('clamps depths below near (no log of ~0)', () => {
    expect(Number.isFinite(edlObscurance(0, ring(0), NEAR, FAR))).toBe(true)
    expect(edlObscurance(NEAR, ring(0), NEAR, FAR)).toBe(0)
  })
})

describe('edlShade', () => {
  it('is 1 with zero obscurance', () => {
    expect(edlShade(0, 1, 1.5)).toBe(1)
  })
  it('is monotonically decreasing in strength and obscurance', () => {
    expect(edlShade(0.5, 2, 1.5)).toBeLessThan(edlShade(0.5, 1, 1.5))
    expect(edlShade(1.0, 1, 1.5)).toBeLessThan(edlShade(0.5, 1, 1.5))
    expect(edlShade(0.5, 0, 1.5)).toBe(1)
  })
  it('darkens less at a larger radius (Boucheny scaling 300/radius)', () => {
    expect(edlShade(0.01, 1, 4)).toBeGreaterThan(edlShade(0.01, 1, 1))
    expect(edlShade(0.01, 1, 1.5)).toBeCloseTo(Math.exp(-1 * 0.01 * 300 / 1.5), 12)
  })
})
