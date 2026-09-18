import { describe, it, expect } from 'vitest'
import { cellKey, exclusiveScan, buildGrid, knn, decodePositions, forEachNeighbour } from './hash'
import { packWords } from '../../format/quant'

function rand(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
function cloud(n: number, seed = 1): Float32Array {
  const r = rand(seed), p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { p[i * 3] = r() * 100; p[i * 3 + 1] = r() * 100; p[i * 3 + 2] = r() * 10 }
  return p
}

describe('cellKey', () => {
  it('wraps like u32 arithmetic and masks', () => {
    expect(cellKey(0, 0, 0, 1023)).toBe(0)
    expect(cellKey(1, 0, 0, 0xffffffff)).toBe(73856093)
    expect(cellKey(60000, 60000, 60000, 1023)).toBeLessThan(1024)
  })
})

describe('exclusiveScan', () => {
  it('matches a running reduce and ends with the total', () => {
    const c = new Uint32Array([3, 0, 5, 1])
    expect(Array.from(exclusiveScan(c))).toEqual([0, 3, 3, 8, 9])
    const r = rand(7), big = new Uint32Array(4096).map(() => Math.floor(r() * 10))
    const s = exclusiveScan(big)
    let acc = 0
    for (let i = 0; i < big.length; i++) { expect(s[i]).toBe(acc); acc += big[i] }
    expect(s[big.length]).toBe(acc)
  })
})

describe('buildGrid', () => {
  it('cellStart[T] == n and every point appears once in sorted', () => {
    const n = 5000, pos = cloud(n), g = buildGrid(pos, n, 2, 1024)
    expect(g.cellStart[1024]).toBe(n)
    expect(Array.from(g.sorted).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
  })
  it('forEachNeighbour visits exactly the points within radius', () => {
    const n = 3000, pos = cloud(n, 3), r = 3, g = buildGrid(pos, n, r, 1024)
    for (const i of [0, 17, 999, 2999]) {
      const got = new Set<number>()
      forEachNeighbour(g, pos, i, r * r, (j) => got.add(j))
      const want = new Set<number>()
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
        if (dx * dx + dy * dy + dz * dz <= r * r) want.add(j)
      }
      expect(got).toEqual(want)
    }
  })
})

describe('knn', () => {
  it('returns the same neighbour set as brute force (10k points, k=16)', () => {
    const n = 10000, pos = cloud(n, 5), r = 2.5, g = buildGrid(pos, n, r, 2048)
    for (const i of [0, 123, 4567, 9999]) {
      const res = knn(g, pos, i, 16)
      const brute = [] as { j: number; d2: number }[]
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 <= r * r) brute.push({ j, d2 })
      }
      brute.sort((a, b) => a.d2 - b.d2)
      const want = brute.slice(0, 16).map((b) => b.j)
      expect(res.n).toBe(want.length)
      expect(new Set(Array.from(res.idx.subarray(0, res.n)))).toEqual(new Set(want))
      for (let m = 1; m < res.n; m++) expect(res.d2[m]).toBeGreaterThanOrEqual(res.d2[m - 1])
    }
  })
})

describe('decodePositions', () => {
  it('is q × dqScale per axis', () => {
    const [w0, w1] = packWords(65535, 0, 32768, 0)
    const p = decodePositions(new Uint32Array([w0, w1]), 1, [0.01, 0.02, 0.03])
    expect(p[0]).toBeCloseTo(655.35, 4); expect(p[1]).toBe(0); expect(p[2]).toBeCloseTo(983.04, 4)
  })
})
