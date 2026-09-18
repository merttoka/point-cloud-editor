import { describe, it, expect } from 'vitest'
import { aoAt, computeAo } from './ao'
import { buildGrid } from './hash'
import { octEncode } from './normals'

function gridPlane(n: number) {      // z = 0 lattice, 1 m pitch, n×n
  const pos = new Float32Array(n * n * 3)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = y * n + x; pos[i * 3] = x + 1; pos[i * 3 + 1] = y + 1; pos[i * 3 + 2] = 5 }
  return pos
}

describe('aoAt', () => {
  it('≈ 1 on a flat plane (no neighbour above the tangent plane)', () => {
    const pos = gridPlane(30), n = 900, g = buildGrid(pos, n, 2.5, 1024)
    expect(aoAt(g, pos, 15 * 30 + 15, [0, 0, 1], 0.05)).toBeCloseTo(1, 6)
  })
  it('lower in an inner corner (floor point next to a wall) than on the open floor', () => {
    // floor z=5 (x 1..30, y 1..30) + wall x=30.5 (y 1..30, z 5..30)
    const floor = gridPlane(30), wallN = 30 * 26, pos = new Float32Array((900 + wallN) * 3)
    pos.set(floor)
    let k = 900
    for (let y = 0; y < 30; y++) for (let z = 0; z < 26; z++) { pos[k * 3] = 30.5; pos[k * 3 + 1] = y + 1; pos[k * 3 + 2] = 5 + z; k++ }
    const n = 900 + wallN, g = buildGrid(pos, n, 2.5, 4096)
    const i = 15 * 30 + 29                                   // floor point at x = 30, next to the wall
    const corner = aoAt(g, pos, i, [0, 0, 1], 0.05), open = aoAt(g, pos, 15 * 30 + 10, [0, 0, 1], 0.05)
    expect(corner).toBeLessThan(0.75)                        // ≈ 0.68: 8 of 25 neighbours are wall points above the plane
    expect(open).toBeCloseTo(1, 6)
    expect(corner).toBeLessThan(open)
  })
  it('1 with no neighbours; computeAo packs bytes', () => {
    const pos = new Float32Array([1, 1, 1, 50, 50, 50]), g = buildGrid(pos, 2, 1, 1024)
    expect(aoAt(g, pos, 0, [0, 0, 1], 0.02)).toBe(1)
    const out = computeAo(g, pos, new Uint32Array([octEncode([0, 0, 1]), octEncode([0, 0, 1])]), 2, 0.02)
    expect(Array.from(out)).toEqual([255, 255])
  })
})
