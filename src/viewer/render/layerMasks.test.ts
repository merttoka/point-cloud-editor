import { describe, it, expect } from 'vitest'
import { MASK_WORDS, SEG_MAX, classBit, getBit, setBit, isVisible, isClassVisible, isSegmentVisible, allVisible, fillVisible, createLayerMasks } from './layerMasks'

describe('layer masks', () => {
  it('a fresh mask has every class and segment visible', () => {
    const m = createLayerMasks()
    expect(m.words.length).toBe(MASK_WORDS)
    expect(allVisible(m.words)).toBe(true)
    expect(isVisible(m.words, 6, 0)).toBe(true)
    expect(isVisible(m.words, 6, SEG_MAX)).toBe(true)
  })
  it('class bits are independent below 31; classes ≥ 31 share bit 31', () => {
    const w = new Uint32Array(MASK_WORDS); fillVisible(w)
    setBit(w, 0, classBit(2), false)
    expect(isClassVisible(w, 2)).toBe(false); expect(isClassVisible(w, 6)).toBe(true)
    setBit(w, 0, classBit(31), false)
    expect(isClassVisible(w, 31)).toBe(false); expect(isClassVisible(w, 40)).toBe(false)
    expect(allVisible(w)).toBe(false)
    setBit(w, 0, classBit(2), true); setBit(w, 0, classBit(200), true)
    expect(allVisible(w)).toBe(true)
  })
  it('segment bits span words 1..8; bit 0 of word 1 is the unsegmented layer', () => {
    const w = new Uint32Array(MASK_WORDS); fillVisible(w)
    setBit(w, 1 + (0 >> 5), 0 & 31, false)
    expect(isSegmentVisible(w, 0)).toBe(false); expect(isSegmentVisible(w, 1)).toBe(true)
    setBit(w, 1 + (255 >> 5), 255 & 31, false)
    expect(isSegmentVisible(w, 255)).toBe(false); expect(getBit(w, 8, 31)).toBe(false)
    expect(isVisible(w, 2, 255)).toBe(false); expect(isVisible(w, 2, 7)).toBe(true)
  })
  it('setBit on bit 31 keeps the word unsigned', () => {
    const w = new Uint32Array(MASK_WORDS)
    setBit(w, 0, 31, true)
    expect(w[0]).toBe(0x80000000)
    setBit(w, 0, 31, false)
    expect(w[0]).toBe(0)
  })
  it('upload records one whole-buffer update range', () => {
    const m = createLayerMasks()
    m.upload()
    expect(m.attr.updateRanges).toEqual([{ start: 0, count: MASK_WORDS }])
    expect(m.attr.version).toBe(1)
  })
})
