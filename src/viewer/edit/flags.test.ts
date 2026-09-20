import { describe, it, expect } from 'vitest'
import { FLAG_SELECTED, FLAG_HIDDEN, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B, scanFlags, unionRange } from './flags'

describe('flags helpers', () => {
  it('unionRange merges and passes null through', () => {
    expect(unionRange(null, null)).toBeNull()
    expect(unionRange({ min: 3, max: 5 }, null)).toEqual({ min: 3, max: 5 })
    expect(unionRange({ min: 3, max: 5 }, { min: 1, max: 4 })).toEqual({ min: 1, max: 5 })
  })
  it('scanFlags counts each bit independently', () => {
    const b = new Uint8Array([FLAG_SELECTED | FLAG_SPLIT_A, FLAG_HIDDEN | FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_B, 0])
    expect(scanFlags(b).counts).toEqual({ selected: 2, hidden: 1, deleted: 1, split: 2 })
  })
  it('scanFlags selRange spans the first..last selected byte', () => {
    const b = new Uint8Array(8); b[2] = FLAG_SELECTED; b[6] = FLAG_SELECTED | FLAG_HIDDEN
    expect(scanFlags(b).selRange).toEqual({ min: 2, max: 6 })
    expect(scanFlags(new Uint8Array(4)).selRange).toBeNull()
  })
})
