import { describe, it, expect } from 'vitest'
import { viridis, turbo, grayscale, buildLut, ASPRS_COLORS, ASPRS_NAMES, SEGMENT_NONE, hexToRgb } from './colormaps'

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

describe('segment LUT and class names', () => {
  it('hexToRgb parses #rrggbb into bytes', () => {
    expect(hexToRgb('#8a8a8a')).toEqual([138, 138, 138])
    expect(hexToRgb('#FF0080')).toEqual([255, 0, 128])
  })
  it('the segments LUT starts as 256 entries of the unsegmented grey', () => {
    const lut = buildLut('segments')
    const [r, g, b] = hexToRgb(SEGMENT_NONE)
    for (let i = 0; i < 256; i++) expect(Array.from(lut.subarray(i * 4, i * 4 + 4))).toEqual([r, g, b, 255])
  })
  it('ASPRS names cover the classes the colour table lists', () => {
    for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 9, 17, 18]) expect(typeof ASPRS_NAMES[k]).toBe('string')
    expect(ASPRS_NAMES[6]).toBe('Building')
  })
})
