import { describe, it, expect } from 'vitest'
import { createUndoRing } from './undo'

describe('undo ring', () => {
  it('undo then redo restores bytes exactly and returns the range', () => {
    const b = new Uint8Array([0, 1, 2, 3, 4, 5])
    const ring = createUndoRing(b)
    ring.push(1, 3)
    b[1] = 9; b[2] = 9; b[3] = 9
    expect(ring.undo()).toEqual({ min: 1, max: 3 })
    expect(Array.from(b)).toEqual([0, 1, 2, 3, 4, 5])
    expect(ring.redo()).toEqual({ min: 1, max: 3 })
    expect(Array.from(b)).toEqual([0, 9, 9, 9, 4, 5])
    expect(ring.undo()).toEqual({ min: 1, max: 3 })
    expect(Array.from(b)).toEqual([0, 1, 2, 3, 4, 5])
    expect(ring.undo()).toBeNull()
  })
  it('a new push clears the redo stack', () => {
    const b = new Uint8Array(4)
    const ring = createUndoRing(b)
    ring.push(0, 0); b[0] = 1
    ring.undo()
    ring.push(1, 1); b[1] = 1
    expect(ring.redoDepth()).toBe(0)
    expect(ring.undoDepth()).toBe(1)
  })
  it('evicts the oldest past 30 commands', () => {
    const b = new Uint8Array(64)
    const ring = createUndoRing(b)
    for (let i = 0; i < 31; i++) { ring.push(i, i); b[i] = 1 }
    expect(ring.undoDepth()).toBe(30)
    for (let i = 0; i < 30; i++) ring.undo()
    expect(b[0]).toBe(1)                       // the first command was evicted, its edit stays
    expect(Array.from(b.slice(1, 31)).every((v) => v === 0)).toBe(true)
  })
  it('evicts by byte cap with fewer than 30 commands', () => {
    const b = new Uint8Array(100)
    const ring = createUndoRing(b, { maxBytes: 250 })
    ring.push(0, 99); ring.push(0, 99); ring.push(0, 99)   // 300 bytes > cap → oldest dropped
    expect(ring.undoDepth()).toBe(2)
    expect(ring.bytes()).toBe(200)
  })
  it('dropLast removes the newest command and its bytes', () => {
    const b = new Uint8Array(4)
    const ring = createUndoRing(b)
    ring.push(0, 3); ring.dropLast()
    expect(ring.undoDepth()).toBe(0); expect(ring.bytes()).toBe(0)
  })
})
