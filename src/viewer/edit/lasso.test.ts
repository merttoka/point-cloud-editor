import { describe, it, expect } from 'vitest'
import { pointInPolygon, polyBounds, packPoly, simplifyPoly, decimatePoly, MAX_LASSO_VERTS } from './lasso'

const P = (...xy: number[]) => new Float32Array(xy)
describe('pointInPolygon (even-odd)', () => {
  const square = P(0, 0, 10, 0, 10, 10, 0, 10)
  it('convex', () => {
    expect(pointInPolygon(5, 5, square, 4)).toBe(true)
    expect(pointInPolygon(15, 5, square, 4)).toBe(false)
    expect(pointInPolygon(-1, 5, square, 4)).toBe(false)
  })
  it('concave (U shape)', () => {
    const u = P(0, 0, 10, 0, 10, 10, 7, 10, 7, 3, 3, 3, 3, 10, 0, 10)
    expect(pointInPolygon(5, 8, u, 8)).toBe(false)   // in the notch
    expect(pointInPolygon(5, 1, u, 8)).toBe(true)
    expect(pointInPolygon(1, 8, u, 8)).toBe(true)
  })
  it('self-touching bow-tie: even-odd counts each lobe once', () => {
    const bow = P(0, 0, 10, 10, 10, 0, 0, 10)
    expect(pointInPolygon(2, 5, bow, 4)).toBe(true)
    expect(pointInPolygon(8, 5, bow, 4)).toBe(true)
    expect(pointInPolygon(5, 2, bow, 4)).toBe(false)
  })
  it('points on a left edge count as inside, on a right edge outside (half-open rule)', () => {
    expect(pointInPolygon(0, 5, square, 4)).toBe(true)
    expect(pointInPolygon(10, 5, square, 4)).toBe(false)
  })
})
describe('polygon helpers', () => {
  it('polyBounds', () => { expect(polyBounds(P(1, 2, -3, 4, 5, -6), 3)).toEqual([-3, -6, 5, 4]) })
  it('packPoly caps at MAX_LASSO_VERTS', () => {
    const poly = Array.from({ length: 300 }, (_, i) => [i, i] as [number, number])
    const { data, count } = packPoly(poly)
    expect(count).toBe(MAX_LASSO_VERTS)
    expect(data.length).toBe(MAX_LASSO_VERTS * 2)
    expect(data[2 * 255]).toBe(255)
  })
  it('decimatePoly keeps ≤ MAX_LASSO_VERTS, the first vertex and the order', () => {
    const poly = Array.from({ length: 1000 }, (_, i) => [i, i * 2] as [number, number])
    const out = decimatePoly(poly)
    expect(out.length).toBeLessThanOrEqual(MAX_LASSO_VERTS)
    expect(out.length).toBe(250)
    expect(out[0]).toEqual([0, 0])
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0])
    expect(decimatePoly(poly.slice(0, 256))).toHaveLength(256)
  })
  it('simplifyPoly drops near-duplicate vertices', () => {
    expect(simplifyPoly([[0, 0], [1, 0], [5, 0], [5.5, 0], [10, 0]], 2)).toEqual([[0, 0], [5, 0], [10, 0]])
  })
})
