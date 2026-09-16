import { describe, it, expect } from 'vitest'
import { makeSyntheticCloud, mulberry32 } from './synthetic'
import { unpackWords, unpackAttr } from '../viewer/format/quant'

describe('mulberry32', () => {
  it('is deterministic and in [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('makeSyntheticCloud', () => {
  it('emits count*2 words with bounds 1000x1000x300', () => {
    const c = makeSyntheticCloud(1000)
    expect(c.count).toBe(1000)
    expect(c.words.length).toBe(2000)
    expect(c.bounds).toEqual({ min: [0, 0, 0], max: [1000, 1000, 300] })
  })
  it('all fields unpack to valid ranges and classes {2,5,6}', () => {
    const c = makeSyntheticCloud(5000, 7)
    const classes = new Set<number>()
    for (let i = 0; i < c.count; i++) {
      const [x, y, z, packed] = unpackWords(c.words[i * 2], c.words[i * 2 + 1])
      expect(x).toBeLessThanOrEqual(65535)
      expect(y).toBeLessThanOrEqual(65535)
      expect(z).toBeLessThanOrEqual(65535)
      const { intensity, cls } = unpackAttr(packed)
      expect(intensity).toBeLessThanOrEqual(255)
      classes.add(cls)
    }
    expect(classes).toEqual(new Set([2, 5, 6]))
  })
  it('is deterministic for a seed', () => {
    const a = makeSyntheticCloud(100, 3), b = makeSyntheticCloud(100, 3)
    expect(a.words).toEqual(b.words)
  })
})
