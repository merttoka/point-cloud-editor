import { describe, it, expect, vi } from 'vitest'
import { createStore, initialState } from './store'

describe('createStore', () => {
  it('get returns initial state', () => {
    const s = createStore(initialState)
    expect(s.get().budget).toBe(1)
    expect(s.get().status).toBe('idle')
  })
  it('set merges a partial and notifies subscribers once', () => {
    const s = createStore(initialState)
    const fn = vi.fn()
    s.subscribe(fn)
    s.set({ budget: 0.5, pointSize: 4 })
    expect(s.get().budget).toBe(0.5)
    expect(s.get().pointSize).toBe(4)
    expect(s.get().colorMode).toBe('height')
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('unsubscribe stops notifications', () => {
    const s = createStore(initialState)
    const fn = vi.fn()
    const off = s.subscribe(fn)
    off()
    s.set({ budget: 0.2 })
    expect(fn).not.toHaveBeenCalled()
  })
  it('set with no change still returns a new object identity', () => {
    const s = createStore(initialState)
    const a = s.get()
    s.set({})
    expect(s.get()).not.toBe(a)
  })
  it('edl defaults: on, 1.5 px, strength 1; nested patch replaces the object', () => {
    const s = createStore(initialState)
    expect(s.get().edl).toEqual({ enabled: true, radiusPx: 1.5, strength: 1 })
    s.set({ edl: { ...s.get().edl, radiusPx: 3 } })
    expect(s.get().edl).toEqual({ enabled: true, radiusPx: 3, strength: 1 })
    expect(initialState.edl.radiusPx).toBe(1.5)   // initial object untouched
  })
  it('phase 4 defaults: flat shading, compute idle at 3× spacing, bench idle', () => {
    const s = createStore(initialState)
    expect(s.get().shading).toBe('flat')
    expect(s.get().compute).toEqual({ status: 'idle', radiusMul: 3, builtRadius: null, timings: [], elapsedMs: null })
    expect(s.get().bench).toEqual({ status: 'idle', progress: 0, n: 0, cpuMs: null, verify: null })
  })
})
