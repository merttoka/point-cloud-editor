import { describe, it, expect } from 'vitest'
import { spacingOf, tableSizeFor, benchWords, BENCH_CAP, K } from './params'

describe('params', () => {
  it('spacing is sqrt(areaXY / N)', () => {
    expect(spacingOf({ min: [0, 0, 0], max: [1000, 1000, 100] }, 2_000_000)).toBeCloseTo(Math.sqrt(1e6 / 2e6), 12)
  })
  it('table size is nextPow2(max(1024, N/8))', () => {
    expect(tableSizeFor(100)).toBe(1024)
    expect(tableSizeFor(2_000_000)).toBe(262144)
    expect(tableSizeFor(20_000_000)).toBe(4194304)
  })
  it('benchWords takes an equal prefix of every chunk, contiguous', () => {
    const words = new Uint32Array(20)            // 10 points, 2 chunks of 5
    for (let i = 0; i < 20; i++) words[i] = i
    const chunks = [{ offset: 0, count: 5 }, { offset: 5, count: 5 }]
    const sub = benchWords(words, chunks, 4)     // 2 per chunk
    expect(Array.from(sub)).toEqual([0, 1, 2, 3, 10, 11, 12, 13])
    expect(benchWords(words, chunks, 10)).toBe(words)   // n >= total: same array, no copy
  })
  it('constants', () => { expect(K).toBe(16); expect(BENCH_CAP).toBe(2_000_000) })
})
