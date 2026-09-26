import { describe, it, expect } from 'vitest'
import { packWords } from '../format/quant'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { ALL, applySegmentBytes, claimSegment, classCounts, classOf, countSegments, freeSegmentId, layerMember, releaseSegment, selectLayer, SEGMENT_PALETTE } from './layers'

// 8 points: classes 2,2,2,2,6,6,6,7
const CLS = [2, 2, 2, 2, 6, 6, 6, 7]
function words() {
  const q = new Uint32Array(16)
  CLS.forEach((c, i) => { const [a, b] = packWords(i, i, i, c << 8); q[i * 2] = a; q[i * 2 + 1] = b })
  return q
}
describe('layers byte ops', () => {
  it('classOf / classCounts read the packed class byte and skip absent classes', () => {
    const q = words()
    expect(classOf(q, 7)).toBe(7)
    expect(classCounts(q, 8)).toEqual({ 2: 4, 6: 3, 7: 1 })
    expect(classCounts(q, 4)).toEqual({ 2: 4 })
  })
  it('claimSegment tags subject points (selected ∧ side ∧ vis) and reports range + count', () => {
    const seg = new Uint8Array(8), flags = new Uint8Array([S, S | A, S | B, 0, S, H, S, 0])
    const r = claimSegment(seg, flags, 8, 3, 'all', ALL)
    expect(r).toEqual({ range: { min: 0, max: 6 }, count: 5 })
    expect(Array.from(seg)).toEqual([3, 3, 3, 0, 3, 0, 3, 0])
    const r2 = claimSegment(seg, flags, 8, 4, 'A', ALL)       // side filter: only byte 1
    expect(r2).toEqual({ range: { min: 1, max: 1 }, count: 1 })
    expect(seg[1]).toBe(4)                                       // exclusive: moved from 3 to 4
    const r3 = claimSegment(seg, flags, 8, 5, 'all', (i) => i >= 6)
    expect(r3).toEqual({ range: { min: 6, max: 6 }, count: 1 })
    expect(claimSegment(seg, new Uint8Array(8), 8, 6, 'all', ALL)).toEqual({ range: null, count: 0 })
  })
  it('releaseSegment zeroes one id and returns its span', () => {
    const seg = new Uint8Array([0, 2, 1, 2, 0, 2, 0, 0])
    expect(releaseSegment(seg, 8, 2)).toEqual({ min: 1, max: 5 })
    expect(Array.from(seg)).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(releaseSegment(seg, 8, 9)).toBeNull()
  })
  it('countSegments counts live (non-deleted) points per id', () => {
    const seg = new Uint8Array([1, 1, 2, 0, 2, 2, 255, 0]), flags = new Uint8Array([0, D, 0, 0, H, 0, 0, 0])
    const c = countSegments(seg, flags, 8)
    expect(c[1]).toBe(1); expect(c[2]).toBe(3); expect(c[255]).toBe(1); expect(c[0]).toBe(0)
  })
  it('freeSegmentId reuses the lowest gap and returns null at 255', () => {
    expect(freeSegmentId([])).toBe(1)
    expect(freeSegmentId([1, 2, 4])).toBe(3)
    expect(freeSegmentId(Array.from({ length: 255 }, (_, k) => k + 1))).toBeNull()
  })
  it('selectLayer replace/add/subtract on visible members only, split tags dropped with the selection', () => {
    const q = words(), seg = new Uint8Array([0, 0, 0, 0, 9, 9, 0, 0])
    const flags = new Uint8Array([S | A, 0, H, 0, S | B, 0, 0, D])
    const vis = (i: number) => (flags[i] & (H | D)) === 0
    expect(selectLayer(flags, 8, layerMember({ class: 2 }, q, seg), 'replace', vis)).toEqual({ min: 0, max: 4 })
    expect(Array.from(flags)).toEqual([S, S, H, S, 0, 0, 0, D])          // byte 2 hidden: never selected; byte 4 lost S+B
    expect(selectLayer(flags, 8, layerMember({ segment: 9 }, q, seg), 'add', vis)).toEqual({ min: 4, max: 5 })
    expect(flags[4]).toBe(S); expect(flags[5]).toBe(S)
    flags[0] = S | A
    expect(selectLayer(flags, 8, layerMember({ class: 2 }, q, seg), 'subtract', vis)).toEqual({ min: 0, max: 3 })
    expect(Array.from(flags)).toEqual([0, 0, H, 0, S, S, 0, D])
    expect(selectLayer(flags, 8, layerMember({ class: 7 }, q, seg), 'add', vis)).toBeNull()   // the only class-7 point is deleted
  })
  it('applySegmentBytes copies known ids, zeroes unknown ones, counts, and keeps count-0 rows', () => {
    const dst = new Uint8Array(8), src = new Uint8Array([1, 1, 0, 3, 3, 3, 7, 0])
    const r = applySegmentBytes(dst, src, [{ id: 1, name: 'a', color: '#ff0000' }, { id: 3, name: 'b', color: '#00ff00' }, { id: 5, name: 'c', color: '#0000ff' }])
    expect(Array.from(dst)).toEqual([1, 1, 0, 3, 3, 3, 0, 0])
    expect(r.unknown).toBe(1)
    expect(r.segments).toEqual([
      { id: 1, name: 'a', color: '#ff0000', count: 2, visible: true },
      { id: 3, name: 'b', color: '#00ff00', count: 3, visible: true },
      { id: 5, name: 'c', color: '#0000ff', count: 0, visible: true },
    ])
  })
  it('palette has 12 distinct #rrggbb entries', () => {
    expect(SEGMENT_PALETTE).toHaveLength(12)
    expect(new Set(SEGMENT_PALETTE).size).toBe(12)
    SEGMENT_PALETTE.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/))
  })
})
