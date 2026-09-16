import { describe, it, expect } from 'vitest'
import { viridis, turbo, grayscale, buildLut, ASPRS_COLORS } from './colormaps'

describe('colormaps', () => {
  it('viridis runs dark purple → yellow', () => {
    const [r0, g0, b0] = viridis(0)
    expect(r0).toBeLessThan(0.35); expect(g0).toBeLessThan(0.1); expect(b0).toBeGreaterThan(0.3)
    const [r1, g1, b1] = viridis(1)
    expect(r1).toBeGreaterThan(0.9); expect(g1).toBeGreaterThan(0.85); expect(b1).toBeLessThan(0.25)
  })
  it('turbo runs dark blue → dark red', () => {
    const [r0, , b0] = turbo(0)
    expect(r0).toBeLessThan(0.3); expect(b0).toBeGreaterThan(0.1)
    const [r1, g1, b1] = turbo(1)
    expect(r1).toBeGreaterThan(0.4); expect(g1).toBeLessThan(0.15); expect(b1).toBeLessThan(0.15)
  })
  it('grayscale is linear', () => {
    expect(grayscale(0.5)).toEqual([0.5, 0.5, 0.5])
  })
  it('lut is 256 RGBA8 texels, alpha 255, clamped', () => {
    const lut = buildLut('viridis')
    expect(lut.length).toBe(1024)
    expect(lut[3]).toBe(255)
    expect(Math.max(...lut)).toBeLessThanOrEqual(255)
  })
  it('class lut puts the ASPRS colour at index = class', () => {
    const lut = buildLut('class')
    expect(Array.from(lut.subarray(6 * 4, 6 * 4 + 3))).toEqual(ASPRS_COLORS[6])
    expect(Array.from(lut.subarray(2 * 4, 2 * 4 + 3))).toEqual(ASPRS_COLORS[2])
    expect(Array.from(lut.subarray(200 * 4, 200 * 4 + 3))).toEqual(ASPRS_COLORS[-1])
  })
})
