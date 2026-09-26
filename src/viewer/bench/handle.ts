import type { Store, ViewerState, Shading, SelectMode, VerifyResult } from '../state/store'
import type { ViewerApi } from '../render/Scene'
import type { Editor } from '../edit/editor'
import type { Poly } from '../edit/lasso'
import { compareResults } from '../compute/verify'
import { BENCH_CAP, SCAN_BLOCK, spacingOf, tableSizeFor } from '../compute/params'
import { WORDS_PER_POINT } from '../format/quant'

// Everything the runbook reads, as thin wrappers over the store and the phase 2–5 APIs. Pure module: no three, no DOM
// at import time (record() touches the DOM only when called), so vitest can cover the arithmetic.

export interface ComputeRow { countMs: number | null; scanMs: number | null; scatterMs: number | null; normalsMs: number | null; aoMs: number | null; totalMs: number | null; wallMs: number | null; radius: number }
export interface FrameRow { ms: number; fps: number; draws: number; width: number; height: number; dpr: number }
export interface MemoryRow { qpos: number; flags: number; normals: number; ao: number; hash: number; total: number }
export interface BenchRow {
  dataset: string; points: number; chunks: number; budget: number; pointSize: number
  env: { ua: string; dpr: number; width: number; height: number; date: string }
  loadMs: number | null; uploadMsTotal: number
  frameDefault: FrameRow; framePostOrbit: FrameRow; edlOff: FrameRow; edlOn: FrameRow; renderGpuMs: number | null
  compute: ComputeRow | null
  cpuBench: { hashMs: number; normalsMs: number; aoMs: number; n: number } | null
  verify: VerifyResult | null
  lasso: { gpuMs: number | null; readbackMs: number; selected: number; cpuSelected: number | null } | null
  pickMs: number[]
  memory: MemoryRow
}
export interface RunAllOptions { skipCpu?: boolean; skipCompute?: boolean; settleMs?: number }

export interface BenchHandle {
  state(): ViewerState
  loadedFraction(): number
  loadMs(): number | null
  uploadMs(): number[]
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>
  settle(ms: number): Promise<void>
  frame(): FrameRow
  renderGpuMs(): Promise<number | null>
  orbit(steps?: number, ms?: number): Promise<void>
  setBudget(frac: number): void
  edl(on: boolean): void
  shading(mode: Shading): void
  compute(radiusMul?: number): Promise<ComputeRow | null>
  cpuBench(): Promise<{ hashMs: number; normalsMs: number; aoMs: number; n: number } | null>
  verify(): Promise<VerifyResult | null>
  classStats(): Promise<Record<number, { n: number; nzHist: number[]; aoMean: number }> | null>
  lasso(polyPx: Poly, mode?: SelectMode): Promise<{ gpuMs: number | null; readbackMs: number; selected: number }>
  pick(x: number, y: number, mode?: SelectMode): Promise<{ ms: number | null; selected: number }>
  cpuPick(x: number, y: number): number | null
  cpuLasso(polyPx: Poly): number
  editor: Editor | null
  memory(): MemoryRow
  record(seconds: number, name?: string): Promise<{ bytes: number; mimeType: string }>
  runAll(opts?: RunAllOptions): Promise<BenchRow>
}

// Hooks the handle needs from inside <Canvas> / the loader that are not on ViewerApi.
export interface BenchHooks {
  editor: Editor
  classStats: () => Promise<Record<number, { n: number; nzHist: number[]; aoMean: number }>>
  cpuPick: (x: number, y: number) => number | null
  cpuLasso: (poly: Poly) => Uint32Array
  renderGpuMs: () => Promise<number | null>
}

// GPU bytes after a build. Select-pipeline buffers (pick 8 B, polygon 2 KB, chunk table) are KB-scale; excluded on purpose.
export function memoryBytes(pointCount: number): MemoryRow {
  const words = Math.ceil(pointCount / 4) * 4
  const T = tableSizeFor(pointCount)
  const hash = (T + 1) * 4 + T * 4 + (T / SCAN_BLOCK) * 4 + pointCount * 4   // cellStart, cellCursor, blockSums, sorted
  const qpos = pointCount * WORDS_PER_POINT * 4, flags = words, normals = pointCount * 4, ao = words
  return { qpos, flags, normals, ao, hash, total: qpos + flags + normals + ao + hash }
}

const sum = (xs: (number | null)[]) => xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0)

export function createBenchHandle(store: Store<ViewerState>, api: ViewerApi, hooks: BenchHooks | null): BenchHandle {
  const ready = () => store.get().status === 'ready'
  const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const waitFor = async (pred: () => boolean, timeoutMs = 120_000) => {
    const t0 = performance.now()
    while (!pred()) {
      if (performance.now() - t0 > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
      await settle(50)
    }
  }
  const frame = (): FrameRow => api.frame?.() ?? { ms: NaN, fps: NaN, draws: 0, width: 0, height: 0, dpr: 1 }
  const radiusFor = (mul: number) => { const m = store.get().manifest!; return mul * spacingOf(m.bounds, m.pointCount) }

  const h: BenchHandle = {
    state: () => store.get(),
    loadedFraction() { const s = store.get(); return s.manifest ? s.loaded.points / s.manifest.pointCount : 0 },
    loadMs: () => store.get().loadMs,
    uploadMs: () => api.uploadLog?.() ?? [],
    waitFor, settle, frame,
    renderGpuMs: () => hooks?.renderGpuMs() ?? Promise.resolve(null),
    orbit: (steps, ms) => api.orbit?.(steps, ms) ?? Promise.resolve(),
    setBudget(frac) { store.set({ budget: Math.min(1, Math.max(0, frac)) }) },
    edl(on) { store.set({ edl: { ...store.get().edl, enabled: on } }) },
    shading(mode) { store.set({ shading: mode }) },
    async compute(radiusMul = store.get().compute.radiusMul) {
      if (!ready() || !api.build) return null
      const radius = radiusFor(radiusMul)
      await api.build(radius)
      const c = store.get().compute
      if (c.status !== 'built') return null
      const g = (pass: string) => c.timings.find((t) => t.pass === pass)?.gpuMs ?? null
      const row = { countMs: g('count'), scanMs: g('scan'), scatterMs: g('scatter'), normalsMs: g('normals'), aoMs: g('ao') }
      return { ...row, totalMs: sum([row.countMs, row.scanMs, row.scatterMs, row.normalsMs, row.aoMs]), wallMs: c.elapsedMs, radius }
    },
    async cpuBench() {
      if (!ready() || !api.cpuBench) return null
      const c = store.get().compute
      const r = await api.cpuBench(c.builtRadius ?? radiusFor(c.radiusMul))
      const b = store.get().bench
      return r && b.cpuMs ? { hashMs: b.cpuMs.hash, normalsMs: b.cpuMs.normals, aoMs: b.cpuMs.ao, n: r.n } : null
    },
    async verify() {
      const s = store.get()
      if (!ready() || !api.cpuBench || !api.readback || s.compute.status !== 'built' || s.manifest!.pointCount > BENCH_CAP) return null
      const [cpu, gpu] = await Promise.all([api.cpuBench(s.compute.builtRadius!), api.readback()])
      if (!cpu) return null
      const verify = compareResults(gpu.normals, gpu.ao, cpu.normals, cpu.ao, cpu.n)
      store.set({ bench: { ...store.get().bench, verify } })
      return verify
    },
    classStats: () => hooks?.classStats() ?? Promise.resolve(null),
    async lasso(polyPx, mode = 'replace') {
      await api.lasso?.(polyPx, mode)
      const e = store.get().edit
      return { gpuMs: e.lasso?.gpuMs ?? null, readbackMs: e.lasso?.readbackMs ?? 0, selected: e.counts.selected }
    },
    async pick(x, y, mode = 'replace') {
      await api.pick?.(x, y, mode)
      const e = store.get().edit
      return { ms: e.pickMs, selected: e.counts.selected }
    },
    cpuPick: (x, y) => hooks?.cpuPick(x, y) ?? null,
    cpuLasso: (poly) => hooks?.cpuLasso(poly).length ?? 0,
    editor: hooks?.editor ?? null,
    memory: () => memoryBytes(store.get().manifest?.pointCount ?? 0),
    async record(seconds, name = 'hero.webm') {
      const canvas = api.canvas?.()
      const cs = canvas as (HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }) | null
      if (!cs || typeof cs.captureStream !== 'function' || typeof MediaRecorder === 'undefined') throw new Error('record(): canvas.captureStream / MediaRecorder unavailable')
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
      const rec = new MediaRecorder(cs.captureStream(30), { mimeType, videoBitsPerSecond: 4_000_000 })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      const done = new Promise<void>((r) => { rec.onstop = () => r() })
      rec.start(250)
      await settle(seconds * 1000)
      rec.stop(); await done
      const blob = new Blob(chunks, { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return { bytes: blob.size, mimeType }
    },
    async runAll(opts = {}) {
      const settleMs = opts.settleMs ?? 3000
      await waitFor(() => h.loadedFraction() === 1 && ready())
      const s = store.get(), m = s.manifest!
      await settle(settleMs)
      const frameDefault = frame()
      await h.orbit(20, 2000); await settle(1000)
      const framePostOrbit = frame()
      h.edl(false); await settle(1500); const edlOff = frame()
      h.edl(true); await settle(1500); const edlOn = frame()
      const renderGpuMs = await h.renderGpuMs()
      const compute = opts.skipCompute ? null : await h.compute()
      const small = m.pointCount <= BENCH_CAP
      const cpuBench = opts.skipCpu || !small ? null : await h.cpuBench()
      const verify = opts.skipCpu || !small || !compute ? null : await h.verify()
      const f = frame()
      const poly: Poly = [[f.width * 0.25, f.height * 0.25], [f.width * 0.75, f.height * 0.25], [f.width * 0.75, f.height * 0.75], [f.width * 0.25, f.height * 0.75]]
      const cpuSelected = hooks ? h.cpuLasso(poly) : null
      const l = await h.lasso(poly)
      const lasso = { ...l, cpuSelected }
      h.editor?.clearSelection()
      const pickMs: number[] = []
      for (let i = 0; i < 5; i++) { const p = await h.pick(f.width / 2, f.height / 2); if (p.ms !== null) pickMs.push(p.ms) }
      h.editor?.clearSelection()
      return {
        dataset: m.name, points: m.pointCount, chunks: m.chunks.length, budget: s.budget, pointSize: s.pointSize,
        env: { ua: navigator.userAgent, dpr: f.dpr, width: f.width, height: f.height, date: new Date().toISOString() },
        loadMs: h.loadMs(), uploadMsTotal: h.uploadMs().reduce((a, b) => a + b, 0),
        frameDefault, framePostOrbit, edlOff, edlOn, renderGpuMs, compute, cpuBench, verify, lasso, pickMs, memory: h.memory(),
      }
    },
  }
  return h
}
