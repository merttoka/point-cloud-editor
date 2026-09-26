import { describe, it, expect, vi } from 'vitest'
import { createStore, initialState, type ViewerState } from '../state/store'
import { createBenchHandle, memoryBytes } from './handle'
import type { ViewerApi } from '../render/Scene'

const manifest = { name: 't', pointCount: 20_000_000, bounds: { min: [0, 0, 0], max: [1000, 1000, 100] }, chunks: [{ offset: 0, count: 20_000_000, bounds: { min: [0, 0, 0], max: [1000, 1000, 100] } }] } as unknown as ViewerState['manifest']

describe('memoryBytes', () => {
  it('matches ARCHITECTURE § Memory at 20M after a build (≈394 MB)', () => {
    const m = memoryBytes(20_000_000)
    expect(m.qpos).toBe(160_000_000)
    expect(m.flags).toBe(20_000_000)
    expect(m.normals).toBe(80_000_000)
    expect(m.ao).toBe(20_000_000)
    expect(m.hash).toBe((4_194_304 + 1) * 4 + 4_194_304 * 4 + (4_194_304 / 256) * 4 + 20_000_000 * 4)
    expect(m.total).toBeGreaterThan(393e6)
    expect(m.total).toBeLessThan(395e6)
  })
  it('flags and ao round up to whole words', () => {
    const m = memoryBytes(5)
    expect(m.flags).toBe(8)
    expect(m.ao).toBe(8)
  })
})

describe('createBenchHandle', () => {
  const api = (): ViewerApi => ({ fit: () => {} })
  it('loadedFraction is 0 without a manifest and points/pointCount with one', () => {
    const store = createStore(initialState)
    const h = createBenchHandle(store, api(), null)
    expect(h.loadedFraction()).toBe(0)
    store.set({ manifest, loaded: { points: 5_000_000, chunks: 1 } })
    expect(h.loadedFraction()).toBe(0.25)
  })
  it('setBudget clamps to [0, 1] and edl/shading write the store', () => {
    const store = createStore(initialState)
    const h = createBenchHandle(store, api(), null)
    h.setBudget(1.7); expect(store.get().budget).toBe(1)
    h.setBudget(-1); expect(store.get().budget).toBe(0)
    h.edl(false); expect(store.get().edl.enabled).toBe(false)
    h.shading('litAo'); expect(store.get().shading).toBe('litAo')
  })
  it('compute() maps PassTiming rows to per-pass gpu ms and returns null when not ready', async () => {
    const store = createStore(initialState)
    const a = api()
    a.build = vi.fn(async () => {
      store.set({ compute: { ...store.get().compute, status: 'built', elapsedMs: 130, timings: [
        { pass: 'count', submitMs: 1, gpuMs: 0.2 }, { pass: 'scan', submitMs: 1, gpuMs: 0.1 }, { pass: 'scatter', submitMs: 1, gpuMs: 0.22 },
        { pass: 'normals', submitMs: 1, gpuMs: 35 }, { pass: 'ao', submitMs: 1, gpuMs: 46 } ] } })
    })
    const h = createBenchHandle(store, a, null)
    expect(await h.compute()).toBeNull()                       // status idle → not ready
    store.set({ manifest, status: 'ready', loaded: { points: 20_000_000, chunks: 1 } })
    const r = await h.compute()
    expect(r).toMatchObject({ countMs: 0.2, scanMs: 0.1, scatterMs: 0.22, normalsMs: 35, aoMs: 46, wallMs: 130 })
    expect(r!.totalMs).toBeCloseTo(81.52, 6)
    expect(r!.radius).toBeGreaterThan(0)
  })
  it('compute() totalMs is null when any pass lacks a timestamp', async () => {
    const store = createStore(initialState)
    const a = api()
    a.build = vi.fn(async () => {
      store.set({ compute: { ...store.get().compute, status: 'built', elapsedMs: 10, timings: [
        { pass: 'count', submitMs: 1, gpuMs: null }, { pass: 'scan', submitMs: 1, gpuMs: 0.1 }, { pass: 'scatter', submitMs: 1, gpuMs: 0.2 },
        { pass: 'normals', submitMs: 1, gpuMs: 1 }, { pass: 'ao', submitMs: 1, gpuMs: 1 } ] } })
    })
    store.set({ manifest, status: 'ready', loaded: { points: 20_000_000, chunks: 1 } })
    const r = await createBenchHandle(store, a, null).compute()
    expect(r?.countMs).toBeNull()
    expect(r?.totalMs).toBeNull()
  })
  it('waitFor rejects after the timeout instead of hanging', async () => {
    const store = createStore(initialState)
    const h = createBenchHandle(store, api(), null)
    await expect(h.waitFor(() => false, 30)).rejects.toThrow(/timed out/)
  })
  it('waitFor aborts immediately on a loader error instead of waiting out the timeout', async () => {
    const store = createStore(initialState)
    const h = createBenchHandle(store, api(), null)
    store.set({ status: 'error', error: 'chunk 3: HTTP 404' })
    const t0 = performance.now()
    await expect(h.waitFor(() => false, 5_000)).rejects.toThrow(/chunk 3: HTTP 404/)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
  it('record rejects with a clear message when captureStream is unavailable', async () => {
    const store = createStore(initialState)
    const a = api(); a.canvas = () => ({} as HTMLCanvasElement)
    const h = createBenchHandle(store, a, null)
    await expect(h.record(1)).rejects.toThrow(/captureStream|MediaRecorder/)
  })
})
