import { describe, it, expect } from 'vitest'
import { ChunkQueue, type ChunkRef } from './chunkQueue'

const mk = (index: number, x: number): ChunkRef => ({ index, offset: index * 10, count: 10, centre: [x, 0, 0] })

describe('ChunkQueue', () => {
  it('pops nearest first for the current camera', () => {
    const q = new ChunkQueue([mk(0, 100), mk(1, 10), mk(2, 50)])
    q.setCamera([0, 0, 0])
    expect(q.pop()?.index).toBe(1)
    expect(q.pop()?.index).toBe(2)
    expect(q.pop()?.index).toBe(0)
    expect(q.pop()).toBeUndefined()
  })
  it('re-sorts remaining chunks when the camera moves', () => {
    const q = new ChunkQueue([mk(0, 100), mk(1, 10), mk(2, 50)])
    q.setCamera([0, 0, 0])
    expect(q.pop()?.index).toBe(1)
    q.setCamera([100, 0, 0])
    expect(q.pop()?.index).toBe(0)
    expect(q.pop()?.index).toBe(2)
  })
  it('size tracks remaining', () => {
    const q = new ChunkQueue([mk(0, 1), mk(1, 2)])
    expect(q.size).toBe(2)
    q.pop()
    expect(q.size).toBe(1)
  })
})
