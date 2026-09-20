import { describe, it, expect } from 'vitest'
import { FLAG_SELECTED, FLAG_HIDDEN, FLAG_DELETED, countFlags, unionRange, wordOf, selectionRange } from './flags'
import { unpackWords } from '../format/quant'

describe('flags helpers', () => {
  it('unionRange merges and passes null through', () => {
    expect(unionRange(null, null)).toBeNull()
    expect(unionRange({ min: 3, max: 5 }, null)).toEqual({ min: 3, max: 5 })
    expect(unionRange({ min: 3, max: 5 }, { min: 1, max: 4 })).toEqual({ min: 1, max: 5 })
  })
  it('countFlags counts each bit independently', () => {
    const b = new Uint8Array([FLAG_SELECTED, FLAG_HIDDEN | FLAG_SELECTED, FLAG_DELETED, 0])
    expect(countFlags(b)).toEqual({ selected: 2, hidden: 1, deleted: 1 })
  })
  it('wordOf packs byte i at shift (i & 3) * 8 — the vertex-stage unpack', () => {
    const b = new Uint8Array([1, 2, 4, 8, 16])
    expect(wordOf(b, 0)).toBe(1 | (2 << 8) | (4 << 16) | (8 << 24))
    expect(wordOf(b, 1)).toBe(16)
    for (let i = 0; i < 5; i++) expect((wordOf(b, i >> 2) >>> ((i & 3) * 8)) & 0xff).toBe(b[i])
  })
  it('selectionRange spans the first..last selected byte', () => {
    const b = new Uint8Array(8); b[2] = FLAG_SELECTED; b[6] = FLAG_SELECTED | FLAG_HIDDEN
    expect(selectionRange(b)).toEqual({ min: 2, max: 6 })
    expect(selectionRange(new Uint8Array(4))).toBeNull()
  })
})
