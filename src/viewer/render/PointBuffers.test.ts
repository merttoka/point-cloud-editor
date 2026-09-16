import { describe, it, expect } from 'vitest'
import { createPointBuffers, FLAG_HIDDEN, FLAG_DELETED } from './PointBuffers'

describe('createPointBuffers', () => {
  it('allocates N*2 position words and ceil(N/4) flag words', () => {
    const b = createPointBuffers(10, 2)
    expect(b.qpos.array.length).toBe(20)
    expect(b.flags.array.length).toBe(3)
    expect(b.loaded.length).toBe(2)
  })
  it('uploadRange copies words at the offset and records an update range', () => {
    const b = createPointBuffers(10, 2)
    b.uploadRange(3, new Uint32Array([7, 8, 9, 10]))
    expect(Array.from(b.qpos.array.slice(6, 10))).toEqual([7, 8, 9, 10])
    expect(b.qpos.updateRanges).toEqual([{ start: 6, count: 4 }])
    expect(b.qpos.version).toBe(1)
  })
  it('flag constants match the spec bits', () => {
    expect(FLAG_HIDDEN).toBe(1)
    expect(FLAG_DELETED).toBe(4)
  })
})
