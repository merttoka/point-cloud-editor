import { describe, it, expect } from 'vitest'
import {
  QMAX, quantize, dequantize, dequantScale, packAttr, unpackAttr, packWords, unpackWords,
  type Bounds,
} from './quant'

describe('quantize/dequantize', () => {
  it('round-trips within half a quantization step', () => {
    const min = -100, max = 900
    const step = (max - min) / QMAX
    for (const v of [-100, 0, 123.456, 899.99, 900]) {
      const q = quantize(v, min, max)
      expect(q).toBeGreaterThanOrEqual(0)
      expect(q).toBeLessThanOrEqual(QMAX)
      expect(Math.abs(dequantize(q, min, max) - v)).toBeLessThanOrEqual(step / 2 + 1e-9)
    }
  })
  it('degenerate range quantizes to 0', () => {
    expect(quantize(5, 5, 5)).toBe(0)
    expect(dequantize(0, 5, 5)).toBe(5)
  })
  it('dequantScale is (max-min)/QMAX per axis', () => {
    const b: Bounds = { min: [0, 10, 20], max: [65535, 20, 20] }
    expect(dequantScale(b)).toEqual([1, 10 / QMAX, 0])
  })
})

describe('packAttr/unpackAttr', () => {
  it('packs intensity low byte, class high byte', () => {
    const p = packAttr(7, 6)
    expect(p).toBe(7 | (6 << 8))
    expect(unpackAttr(p)).toEqual({ intensity: 7, cls: 6 })
  })
  it('matches on-disk little-endian byte order [intensity][class]', () => {
    const bytes = new Uint8Array(new Uint16Array([packAttr(0xab, 0xcd)]).buffer)
    expect(Array.from(bytes)).toEqual([0xab, 0xcd])
  })
})

describe('packWords/unpackWords', () => {
  it('two u32 words carry x|y<<16 and z|packed<<16', () => {
    const [w0, w1] = packWords(1, 2, 3, packAttr(4, 5))
    expect(w0 >>> 0).toBe(1 | (2 << 16))
    expect(w1 >>> 0).toBe(3 | (packAttr(4, 5) << 16))
    expect(unpackWords(w0, w1)).toEqual([1, 2, 3, packAttr(4, 5)])
  })
  it('u32 view of on-disk bytes equals packWords', () => {
    const disk = new Uint16Array([100, 200, 300, packAttr(9, 2)])
    const words = new Uint32Array(disk.buffer)
    const [w0, w1] = packWords(100, 200, 300, packAttr(9, 2))
    expect(words[0]).toBe(w0 >>> 0)
    expect(words[1]).toBe(w1 >>> 0)
  })
  it('handles max u16 values without sign issues', () => {
    const [w0, w1] = packWords(65535, 65535, 65535, 65535)
    expect(unpackWords(w0, w1)).toEqual([65535, 65535, 65535, 65535])
  })
})
