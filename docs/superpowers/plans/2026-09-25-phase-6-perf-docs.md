# Phase 6: Perf & Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the finished viewer to `lab.merttoka.com/point-cloud` behind a Vercel proxy, with reproducible perf numbers (one in-page `runAll` per dataset, dated JSON rows) and the public docs (README, ARCHITECTURE, EMBEDDING, media).

**Architecture:** The viewer stays a self-contained component (`src/viewer/`, no globals, no URL parsing) and gains one prop, `onApi`, through which the harness (`src/App.tsx`) receives a `BenchHandle`. The harness attaches it to `window.__pcv` under `?bench=1`. This repo deploys as its own Vercel project at `base /point-cloud/app/` with both datasets fetched at build time; the Lab proxies that path (same-origin) and renders it in an iframe under its header.

**Tech Stack:** three 0.186.0 (`three/webgpu` + TSL), @react-three/fiber 9.7.0, drei 10.7.8, React 19.3.0, Vite 8.3.0, TypeScript, vitest, pytest, ffmpeg 8.1.2 (media only), Vercel (Hobby), Playwright MCP (headless Chromium).

**Spec:** `docs/superpowers/specs/2026-09-15-phase-6-perf-docs-design.md` (with its **Amendments P6-1…P6-10** at the bottom, which win over the body) and `docs/superpowers/specs/2026-09-17-spec-review-phases-3-6.md` § Phase 6 (items 1–18). Master spec: `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md`.

## Global Constraints

- Pinned deps only (`three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `vite@8.3.0`); approved extras vitest, pytest, `fflate@0.8.3`. **No new npm dependencies** (no `playwright`, no `vercel` package). `.npmrc` keeps `legacy-peer-deps=true` + `save-exact=true`.
- WebGPU only. Compute rules from `CLAUDE.md` apply to any kernel touched (none are planned).
- `src/viewer/` self-contained: CSS modules, `--pcv-*` tokens, keys on the viewer root only, **no `window` globals, no `location`/URL parsing, no `import.meta.env.DEV`** after this phase (P6-3).
- StrictMode stays on; every effect that creates a handle must be idempotent under mount → cleanup → mount.
- vitest runs in node: unit tests import pure modules only (`src/viewer/bench/handle.ts` must not import `three`, `react`, or DOM at module level).
- Commit messages: concise, **no attribution / Co-Authored-By lines**.
- Measured configuration for every published number: headless Chromium via Playwright MCP, DPR 1, point size 2 px, M4 Max, vsync 240 Hz (4.17 ms floor). Numbers cite `docs/bench/<file>.json` keys.
- Branch `phase-6-perf-docs` from `main`. Gates before merge: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `tools/.venv/bin/pytest tools/tests -q`. `README.md` before every push; `docs/ARCHITECTURE.md` on merge.
- The Lab repo (`/Users/toka/Professional/Public/website/lab`) is touched in Task 8 only; read its `CLAUDE.md` first; **commit there, do not push** (Vercel auto-deploys the Lab on push; the user decides).

## Rulings on the spec-review items (Phase 6 §1–18)

1. Attribution → OGL Vancouver line (Task 9). 2. Hosting → P6-1/P6-2 (Tasks 6–8). 3/9. Dev globals → all folded into the handle, `import.meta.env.DEV` removed (Task 2). 4. Load time → `loadMs` measured in `useLoader` under `vite preview` (Task 1); Phase 2 dev-server numbers kept as a baseline note. 5. Frame rows re-measured EDL on/off (Task 7). 6. Memory columns: computed vs GPU-process RSS (Task 7). 7/17. Media → MediaRecorder (Task 3), PNG fallback. 8. Master spec status (Task 9). 10. `compute()` returns per-pass `gpuMs` + `wallMs`; README cites gpu. 11. `cpuBench()` takes no `n`. 12. `frame()` from `api.frame` written by `Hud`; `data-pcv-hud`. 13. `api.orbit` in `CameraRig`. 14. `memory()` breakdown per P6-4. 15. All rows re-run in one dated session. 16. EMBEDDING lists `dpr`, `onApi`, `fflate@0.8.3`. 18. Settled by P6-1/P6-2.

## Review Focus

1. **`onApi` fires once per loaded dataset, not once per render.** Expect: the handle identity on `window.__pcv` is stable across store updates and re-renders (a handle holds no resources, so StrictMode's dev double-mount producing two is harmless, but a per-render `onApi` closure would rebuild it on every state change). Browser check in Task 2 Step 8; the harness keeps `attach` at module scope for this reason.
2. **`runAll` on a dataset that never finishes loading** (a chunk 404). Expect: it rejects with a clear error after a bounded wait instead of hanging the MCP evaluate forever (Task 3 unit test on `waitFor` timeout).
3. **`record()` when `MediaRecorder`/`captureStream` is missing** (Safari, some headless builds). Expect: it rejects with a message naming the missing API; the rest of the handle still works (Task 3 unit test with a fake canvas).
4. **Proxy drops `Range`** (200 + full body through the Lab route). Expect: the loader's single-fetch fallback carries the load; the runbook records which path was taken (Task 6 `check_hosting.py --no-cors` result + `?data=full` browser check via the Lab URL).
5. **Theme message from a foreign origin.** Expect: `App.tsx` ignores `message` events whose `origin !== location.origin` (Task 5 unit test on `themeFromMessage`).

---

### Task 1: Store `loadMs`, `api.frame` / `api.orbit` / `api.uploadLog`, `data-pcv-hud`

**Files:**
- Modify: `src/viewer/state/store.ts` (add `loadMs: number | null` to `ViewerState` + `initialState`)
- Modify: `src/viewer/render/Scene.tsx` (`ViewerApi` additions; `CameraRig` sets `api.orbit`)
- Modify: `src/viewer/ui/Hud.tsx` (writes `api.frame`)
- Modify: `src/viewer/loader/useLoader.ts` (`loadMs`, `api.uploadLog`)
- Modify: `src/viewer/PointCloudViewer.tsx` (`data-pcv-hud`, pass `api` to `Hud`)
- Test: `src/viewer/state/store.test.ts`

**Interfaces:**
- Produces on `ViewerApi`: `frame?: () => { ms: number; fps: number; draws: number; width: number; height: number; dpr: number }`, `orbit?: (steps?: number, ms?: number) => Promise<void>`, `uploadLog?: () => number[]`, `canvas?: () => HTMLCanvasElement | null`.
- Produces on `ViewerState`: `loadMs: number | null` (manifest fetch start → `done`).

- [ ] **Step 1: Failing test for `loadMs` in the initial state**

Append to `src/viewer/state/store.test.ts`:
```ts
describe('loadMs', () => {
  it('starts null and is a top-level key (merged by set)', () => {
    const s = createStore(initialState)
    expect(s.get().loadMs).toBeNull()
    s.set({ loadMs: 412.5 })
    expect(s.get().loadMs).toBe(412.5)
    expect(s.get().status).toBe('idle')
  })
})
```

- [ ] **Step 2: Run it, expect a type error / failure**

Run: `npx vitest run src/viewer/state/store.test.ts`
Expected: FAIL (`loadMs` not in `ViewerState`; tsc also errors).

- [ ] **Step 3: Add `loadMs` to the store**

In `src/viewer/state/store.ts`, `ViewerState`: after `loaded: { points: number; chunks: number }` add `loadMs: number | null   // manifest fetch start → last chunk uploaded; null until ready`. In `initialState` after `loaded: { points: 0, chunks: 0 },` add `loadMs: null,`.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run src/viewer/state/store.test.ts` → PASS.

- [ ] **Step 5: Extend `ViewerApi` and wire `orbit`, `frame`, `uploadLog`, `canvas`**

`src/viewer/render/Scene.tsx`, inside `ViewerApi` add:
```ts
  frame?: () => { ms: number; fps: number; draws: number; width: number; height: number; dpr: number }   // Hud's EMA (bench handle)
  orbit?: (steps?: number, ms?: number) => Promise<void>                // scripted full turn around the target (bench handle)
  uploadLog?: () => number[]                                            // per-chunk GPU upload ms (bench handle)
  canvas?: () => HTMLCanvasElement | null                               // renderer's canvas (bench handle: record())
```
In `CameraRig`, inside the existing `useEffect` after `api.fit = fit`:
```ts
    // One full turn around the target in `steps` frames spread over `ms`; each step goes through controls.update()
    // so damping and the loader's camera-priority path see it exactly like a user drag.
    api.orbit = async (steps = 20, ms = 2000) => {
      const c = controls.current
      if (!c) return
      const cam = camera as THREE.PerspectiveCamera
      const offset = new THREE.Vector3().subVectors(cam.position, c.target)
      const axis = cam.up.clone().normalize()
      for (let i = 1; i <= steps; i++) {
        offset.applyAxisAngle(axis, (2 * Math.PI) / steps)
        cam.position.copy(c.target).add(offset)
        cam.lookAt(c.target)
        c.update()
        await new Promise((r) => setTimeout(r, ms / steps))
      }
    }
```
and in the same effect's cleanup (add one if none exists): `return () => { api.orbit = undefined }`.

`src/viewer/ui/Hud.tsx`: change the signature to `export function Hud({ el, api }: { el: RefObject<HTMLDivElement | null>; api: ViewerApi })`, import `type ViewerApi` from `'../render/Scene'`, and add before `useFrame`:
```ts
  const draws = useRef(0)
  useEffect(() => {
    api.frame = () => {
      const canvas = (gl as unknown as WebGPURenderer).domElement
      return { ms: ema.current, fps: 1000 / ema.current, draws: draws.current, width: canvas.clientWidth, height: canvas.clientHeight, dpr: gl.getPixelRatio() }
    }
    api.canvas = () => (gl as unknown as WebGPURenderer).domElement
    return () => { api.frame = undefined; api.canvas = undefined }
  }, [api, gl])
```
Inside `useFrame`, before `info.reset()`, add `draws.current = info.render.drawCalls` (the HUD text keeps reading `info.render.drawCalls`). Add `useEffect` to the react import.

`src/viewer/render/Scene.tsx`: `<Hud el={hudEl} api={api} />`.

`src/viewer/loader/useLoader.ts`: in the first effect, before `fetchManifest(...)`, add `const t0 = performance.now()` and pass it through the `Loaded` object: add `loadT0: number` to `interface Loaded` and `setLoaded({ manifest, binUrl, buffers, handle, editor, loadT0: t0 })`. In the `'done'` branch replace `store.set({ status: 'ready' })` with `store.set({ status: 'ready', loadMs: performance.now() - loaded.loadT0 })`. Replace the `__pcvUploadMs` line with `api.uploadLog = () => uploadLog.current.slice()` (placed right after `worker.postMessage(start)` alongside `api.sendCamera = …`), and in the cleanup add `api.uploadLog = undefined`. Reset `store.set({ …, loadMs: null })` in the first effect's initial `store.set` call. (Leave the other `import.meta.env.DEV` blocks for Task 2.)

`src/viewer/PointCloudViewer.tsx`: `<div id="hud" …>` → `<div data-pcv-hud ref={hudEl} className={styles.hud} />`.

- [ ] **Step 6: Gates + browser check**

Run: `npx tsc --noEmit && npx vitest run` → clean. `npm run dev`; Playwright: `browser_navigate` `http://localhost:5173/`, `browser_wait_for` text `2,000,000 / 2,000,000` (Panel), `browser_evaluate` `() => document.querySelector('[data-pcv-hud]')?.textContent` → non-empty HUD line; console clean. (The `?bench` handle does not exist yet; `api.frame` is exercised in Task 2.)

- [ ] **Step 7: Commit**

```bash
git add src/viewer && git commit -m "viewer: loadMs in store, api.frame/orbit/uploadLog/canvas, data-pcv-hud"
```

### Task 2: `BenchHandle` + `onApi` prop; delete the dev globals

**Files:**
- Create: `src/viewer/bench/handle.ts` (pure: handle factory + `memoryBytes`)
- Create: `src/viewer/bench/cpuReference.ts` (moved from `useLoader`'s DEV block)
- Create: `src/viewer/bench/handle.test.ts`
- Modify: `src/viewer/PointCloudViewer.tsx` (`onApi` prop, handle lifecycle)
- Modify: `src/viewer/loader/useLoader.ts`, `src/viewer/compute/ComputeRunner.tsx`, `src/viewer/edit/EditRunner.tsx` (remove `import.meta.env.DEV` blocks; keep `api.viewParams` unconditional; expose `classStats`)
- Modify: `src/App.tsx` (`?bench=1` → `window.__pcv`)

**Interfaces:**
- Consumes: Task 1's `api.frame/orbit/uploadLog/canvas`, `store.loadMs`; existing `api.build/readback/cpuBench/pick/lasso/viewParams`, `Editor`, `compareResults`, `BENCH_CAP`, `tableSizeFor`, `WORDS_PER_POINT`.
- Produces: `BenchHandle` (below), `PointCloudViewerProps.onApi?: (h: BenchHandle) => void`, `memoryBytes(pointCount, chunkCount)`.

- [ ] **Step 1: Failing tests for the pure parts**

`src/viewer/bench/handle.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createStore, initialState, type ViewerState } from '../state/store'
import { createBenchHandle, memoryBytes } from './handle'
import type { ViewerApi } from '../render/Scene'

const manifest = { name: 't', pointCount: 20_000_000, bounds: { min: [0, 0, 0], max: [1000, 1000, 100] }, chunks: [{ offset: 0, count: 20_000_000, bounds: { min: [0, 0, 0], max: [1000, 1000, 100] } }] } as unknown as ViewerState['manifest']

describe('memoryBytes', () => {
  it('matches ARCHITECTURE § Memory at 20M after a build (≈394 MB)', () => {
    const m = memoryBytes(20_000_000, 1)
    expect(m.qpos).toBe(160_000_000)
    expect(m.flags).toBe(20_000_000)
    expect(m.normals).toBe(80_000_000)
    expect(m.ao).toBe(20_000_000)
    expect(m.hash).toBe((4_194_304 + 1) * 4 + 4_194_304 * 4 + (4_194_304 / 256) * 4 + 20_000_000 * 4)
    expect(m.total).toBeGreaterThan(393e6)
    expect(m.total).toBeLessThan(395e6)
  })
  it('flags and ao round up to whole words', () => {
    const m = memoryBytes(5, 1)
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
  it('record rejects with a clear message when captureStream is unavailable', async () => {
    const store = createStore(initialState)
    const a = api(); a.canvas = () => ({} as HTMLCanvasElement)
    const h = createBenchHandle(store, a, null)
    await expect(h.record(1)).rejects.toThrow(/captureStream|MediaRecorder/)
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run src/viewer/bench/handle.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `src/viewer/bench/handle.ts`**

```ts
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

export function memoryBytes(pointCount: number, chunkCount: number): MemoryRow {
  const words = Math.ceil(pointCount / 4) * 4
  const T = tableSizeFor(pointCount)
  const hash = (T + 1) * 4 + T * 4 + (T / SCAN_BLOCK) * 4 + pointCount * 4   // cellStart, cellCursor, blockSums, sorted
  const qpos = pointCount * WORDS_PER_POINT * 4, flags = words, normals = pointCount * 4, ao = words
  void chunkCount   // select-pipeline buffers (pick 8 B, polygon 2 KB, chunk table) are KB-scale; excluded on purpose
  return { qpos, flags, normals, ao, hash, total: qpos + flags + normals + ao + hash }
}

const sum = (xs: (number | null)[]) => xs.some((x) => x === null) ? null : xs.reduce((a, b) => a + (b ?? 0), 0)

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
    memory() { const m = store.get().manifest; return m ? memoryBytes(m.pointCount, m.chunks.length) : memoryBytes(0, 0) },
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
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run src/viewer/bench/handle.test.ts` → PASS (the `record` test passes because `{}` has no `captureStream`).

- [ ] **Step 5: Move the CPU reference out of `useLoader` into `src/viewer/bench/cpuReference.ts`**

```ts
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import type { ViewerApi } from '../render/Scene'
import { centroidOf } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import { cpuLasso, cpuPick, decodeWorld, projectPoint } from '../edit/project'
import { packPoly, type Poly } from '../edit/lasso'
import { FLAG_DELETED, FLAG_HIDDEN } from '../edit/flags'

// CPU reference for the GPU select kernels: same matrices (api.viewParams from EditRunner), same visibility rule
// (not hidden/deleted, inside the chunk's budget prefix), same attenuated radius as pickDepth.
export function createCpuReference(buffers: PointBuffers, manifest: Manifest, api: ViewerApi) {
  const centroid = centroidOf(manifest.bounds)
  const dq = dequantScale(manifest.bounds), b = manifest.bounds
  const dqMin: [number, number, number] = [b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]]
  const q = buffers.qpos.array as Uint32Array
  const ref = () => {
    const v = api.viewParams!()
    const end = new Uint32Array(manifest.chunks.length)
    manifest.chunks.forEach((ch, k) => { end[k] = ch.offset + (buffers.loaded[k] ? Math.ceil(ch.count * v.budget) : 0) })
    const chunkOf = (i: number) => { let lo = 0, hi = manifest.chunks.length; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (manifest.chunks[m].offset <= i) lo = m; else hi = m }; return lo }
    const visible = (i: number) => (buffers.flagBytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && i < end[chunkOf(i)]
    const m = v.view.elements
    const radiusPx = (i: number) => {
      const [x, y, z] = decodeWorld(q, i, dq, dqMin)
      const viewZ = m[2] * x + m[6] * y + m[10] * z + m[14]
      return Math.max(3, Math.min(8, Math.max(1, v.pointSize * v.refDist / -viewZ)))
    }
    return { v, vp: v.viewProj.elements, visible, radiusPx }
  }
  return {
    cpuPick: (x: number, y: number) => { const r = ref(); return cpuPick(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, x, y, r.visible, r.radiusPx) },
    cpuLasso: (poly: Poly) => { const r = ref(); const { data, count } = packPoly(poly); return cpuLasso(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, data, count, r.visible) },
    depthOf: (i: number) => { const r = ref(); const [x, y, z] = decodeWorld(q, i, dq, dqMin); return projectPoint(x, y, z, r.vp, r.v.width, r.v.height)?.[2] ?? null },
  }
}
```
In `useLoader.ts`: delete the whole `if (import.meta.env.DEV) { … w.__pcvEdit = … }` block, the `exportDone` DEV block (keep the `download` + `patchEdit` lines), the cleanup's DEV block, and the now-unused imports (`cpuLasso, cpuPick, decodeWorld, projectPoint`, `packPoly`, `FLAG_DELETED, FLAG_HIDDEN`; keep `type Poly` only if still referenced). Remove `cpuPick?`/`cpuLasso?` from `ViewerApi` (they move to `BenchHooks`).

`EditRunner.tsx`: `if (import.meta.env.DEV) api.viewParams = params` → `api.viewParams = params` (cleanup already clears it).

`ComputeRunner.tsx`: keep `classStats` but expose it on the api instead of `window`: add `classStats?: () => Promise<Record<number, { n: number; nzHist: number[]; aoMean: number }>>` and `renderGpuMs?: () => Promise<number | null>` to `ViewerApi`; replace the whole `if (import.meta.env.DEV) { … }` block with `api.classStats = classStats` (the `classStats` const stays; delete `cpuCellStart` and its `buildGrid/decodePositions/dequantScale` imports if unused elsewhere in the file), and in the cleanup `api.classStats = undefined` instead of the `delete window…` line.

`PostPass.tsx`: after the `useLayoutEffect` add
```ts
  // Bench: GPU time of the next frame's render passes (scene pass + EDL quad) via the render timestamp query.
  useEffect(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    api.renderGpuMs = async () => {
      if (!r.hasFeature('timestamp-query')) return null
      await new Promise<void>((res) => requestAnimationFrame(() => res()))
      const ms = await r.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      return ms ?? null
    }
    return () => { api.renderGpuMs = undefined }
  }, [gl, api])
```
with `PostPass` taking `{ api }: { api: ViewerApi }` (`<PostPass api={api} />` in `Scene`), `import * as THREE from 'three/webgpu'` (value import now, for `TimestampQuery`).

- [ ] **Step 6: `onApi` prop and handle lifecycle in `PointCloudViewer.tsx`**

Add to `PointCloudViewerProps`: `onApi?: (handle: BenchHandle) => void   // bench/automation hook; called once per loaded dataset`. In `ViewerInner` (destructure `onApi`), after `const loaded = useLoader(manifestUrl, api)`:
```ts
  // One handle per dataset: built when the loader hands over buffers, so editor/CPU references exist. `hooks` closes
  // over api.* getters that the <Canvas> runners fill in later, so a handle built before <Scene> mounts still works.
  useEffect(() => {
    if (!onApi || !loaded) return
    const ref = createCpuReference(loaded.buffers, loaded.manifest, api)
    const hooks: BenchHooks = {
      editor: loaded.editor,
      classStats: () => api.classStats?.() ?? Promise.reject(new Error('compute not mounted')),
      cpuPick: ref.cpuPick, cpuLasso: ref.cpuLasso,
      renderGpuMs: () => api.renderGpuMs?.() ?? Promise.resolve(null),
    }
    onApi(createBenchHandle(store, api, hooks))
  }, [onApi, loaded, store, api])
```
Imports: `createBenchHandle, type BenchHandle, type BenchHooks` from `'./bench/handle'`, `createCpuReference` from `'./bench/cpuReference'`. Re-export the type: `export type { BenchHandle } from './bench/handle'`.

- [ ] **Step 7: Harness attaches `window.__pcv` under `?bench=1`**

`src/App.tsx`: add `const bench = params.get('bench') === '1'` and
```tsx
      <PointCloudViewer manifestUrl={`${import.meta.env.BASE_URL}data/${dataset}/manifest.json`} dpr={dpr}
        onApi={bench ? (h) => { (window as unknown as { __pcv?: unknown }).__pcv = h } : undefined} />
```
(`BASE_URL` is `/` until Task 6 sets the base; using it now keeps Task 6 a config-only change.) Note: `onApi` must be a stable reference — hoist it to module scope: `const attach = (h: BenchHandle) => { (window as unknown as { __pcv?: unknown }).__pcv = h }` and pass `onApi={bench ? attach : undefined}`.

- [ ] **Step 8: Gates, grep gate, browser check**

Run: `npx tsc --noEmit && npx vitest run && grep -rn '__pcv\|import.meta.env.DEV' src/viewer ; echo "grep exit $?"` → tsc/vitest clean, grep prints nothing (exit 1).
Browser (`npm run dev`): `http://localhost:5173/?bench=1` → `browser_wait_for` `2,000,000 / 2,000,000`; `browser_evaluate` `() => typeof __pcv` → `"object"`; `() => __pcv.frame()` → finite `ms`; `() => __pcv.memory().total` → 21_500_000 ± (2M: qpos 16M + flags 2M + normals 8M + ao 2M + hash); `async () => (await __pcv.compute())?.normalsMs` → ~35; `async () => { await __pcv.orbit(10, 500); return __pcv.frame().draws }` → > 0. Identity check: `() => { const a = __pcv; __pcv.edl(false); return a === __pcv }` → `true`. Then `http://localhost:5173/` (no bench): `() => typeof __pcv` → `"undefined"`. Console clean both times.

- [ ] **Step 9: Commit**

```bash
git add src && git commit -m "bench: BenchHandle via onApi prop (frame/orbit/compute/cpuBench/verify/lasso/pick/memory/record/runAll); dev globals removed; renderGpuMs via render timestamp query"
```

### Task 3: `runAll` end-to-end in the browser, runbook, first bench row

**Files:**
- Create: `scripts/bench.md` (runbook)
- Create: `docs/bench/README.md` (row schema, 5 lines) and `docs/bench/2026-09-XX-m4max.json` (first real row = demo)
- Modify: `src/viewer/bench/handle.ts` only if the browser run finds a bug (then add the unit test that pins it)

**Interfaces:**
- Consumes: `window.__pcv` (Task 2).
- Produces: the runbook every later measurement follows; `docs/bench/*.json` rows keyed as `BenchRow`.

- [ ] **Step 1: Write `scripts/bench.md`**

````markdown
# Bench runbook

Every number in README § Performance cites a row in `docs/bench/<date>-<machine>.json` produced by these steps. One
`browser_evaluate` per dataset; nothing polls the page while the full set streams.

## Environment (record in the row's `env` and in the JSON file name)
- Machine, macOS, Chromium version (`navigator.userAgent` is in the row), Playwright MCP headless, DPR 1 (`?dpr=1`), point size 2 px.
- Serve the production build: `npm run build && npm run preview` → `http://localhost:4173/point-cloud/app/`.

## Per dataset
1. GPU-process RSS before: `ps -eo rss,command | grep -- '--type=gpu-process' | grep -v grep` (KB).
2. `browser_navigate` `http://localhost:4173/point-cloud/app/?bench=1&dpr=1&data=demo` (`full` for 10M/20M rows).
3. `browser_wait_for` text `2,000,000 / 2,000,000` (demo) or `20,000,000 / 20,000,000` (full). Time budget: ≤ 10 s demo, ≤ 60 s full.
4. 10M row only: `browser_evaluate` `() => __pcv.setBudget(0.5)`.
5. `browser_evaluate` `async () => JSON.stringify(await __pcv.runAll({ skipCpu: true }))` → paste the JSON as the row (2M/10M/20M keys `frameDefault`, `framePostOrbit`, `edlOff`, `edlOn`, `renderGpuMs`, `compute`, `lasso`, `pickMs`, `memory`, `loadMs`).
6. Demo only, two more evaluates (each ≈ 15 s, kept separate from runAll so no single evaluate exceeds the MCP timeout):
   `async () => JSON.stringify(await __pcv.cpuBench())` and `async () => JSON.stringify(await __pcv.verify())` → fill `cpuBench`, `verify`.
7. GPU-process RSS after (same `ps` line) → row `rssDeltaKB` (added by hand; not part of `runAll`).
8. `browser_console_messages` → must be clean (no errors, no `GPUValidationError`).
9. Headed run (optional): same steps in Chrome via the Chrome MCP; store as a second file `…-headed.json`.

## Row → README
| README cell | row key |
|---|---|
| load time | `loadMs` |
| frame default → post-orbit | `frameDefault.ms/fps` → `framePostOrbit.ms/fps`, `draws` |
| EDL delta | `edlOff.ms` vs `edlOn.ms`, `renderGpuMs` |
| compute per pass | `compute.{countMs,scanMs,scatterMs,normalsMs,aoMs,totalMs}` (GPU) and `compute.wallMs` |
| CPU bench / verify | `cpuBench.*`, `verify.*` (demo only) |
| lasso / pick | `lasso.gpuMs`, `lasso.readbackMs`, `lasso.selected` (= `lasso.cpuSelected`), `pickMs` (median of 5) |
| memory computed / RSS proxy | `memory.total` / `rssDeltaKB` |

## Media
- `hero.webm`: on the demo, `browser_evaluate` `async () => { const p = __pcv.record(12, 'hero.webm'); await __pcv.orbit(60, 6000); await __pcv.lasso([[300,200],[900,200],[900,600],[300,600]]); __pcv.editor.split(); await __pcv.settle(1500); __pcv.edl(false); await __pcv.settle(1500); __pcv.edl(true); return JSON.stringify(await p) }` → file lands in the Playwright download dir (`.playwright-mcp/`). Then `ffmpeg -i hero.webm -c:v libvpx-vp9 -b:v 1.5M -vf scale=1280:-2 docs/media/hero.webm` and `ffmpeg -i hero.webm -c:v libx264 -crf 23 -pix_fmt yuv420p -vf scale=1280:-2 docs/media/hero.mp4`.
- PNGs: `browser_resize` 1280×720, `browser_take_screenshot` for overview / classification / normals+AO / lasso / split.
- Fallback if `record()` rejects (no MediaRecorder): 30 screenshots during `orbit(30, 6000)` → `ffmpeg -framerate 5 -i frame_%02d.png …`.
````

- [ ] **Step 2: Run the demo row end-to-end**

Follow the runbook for `demo` (dev server is fine for this task's smoke; the committed row comes from `vite preview` in Task 7). Save the JSON to `docs/bench/2026-09-XX-m4max.json` as `{ "rows": [ <row> ] }` with the real date. Add `docs/bench/README.md`: three lines saying rows are `BenchRow` from `src/viewer/bench/handle.ts`, file name = date + machine, `rssDeltaKB` and `headed` are hand-added keys.

- [ ] **Step 3: Fix anything the run reveals**

If `runAll` throws or a key is wrong, fix `handle.ts` and add a unit test that pins the behaviour (same style as Task 2 Step 1).

- [ ] **Step 4: Commit**

```bash
git add scripts/bench.md docs/bench src/viewer/bench && git commit -m "bench: runbook, first demo row"
```

### Task 4: `check_hosting.py --no-cors`

**Files:**
- Modify: `tools/check_hosting.py`
- Test: `tools/tests/test_check_hosting.py`

**Interfaces:**
- Produces: `evaluate(hops, origin, cors=True)`; CLI `check_hosting.py [--no-cors] URL`.

- [ ] **Step 1: Failing test**

Append to `tools/tests/test_check_hosting.py`:
```python
def test_evaluate_no_cors_skips_cors_rows():
    hops = [Hop("https://a/x.bin", 206, {"content-range": "bytes 0-15/100", "accept-ranges": "bytes"}, 16)]
    rows = evaluate(hops, "https://example.com", cors=False)
    assert not any(name.startswith("cors") for name, _, _ in rows)
    assert all(ok for _, ok, _ in rows)
```

- [ ] **Step 2: Run, expect failure**

Run: `tools/.venv/bin/pytest tools/tests/test_check_hosting.py -q` → FAIL (`cors` kwarg).

- [ ] **Step 3: Implement**

`evaluate(hops, origin, cors: bool = True)`: wrap the CORS loop in `if cors:`. In `main`: parse `--no-cors` (`cors = "--no-cors" not in argv; argv = [a for a in argv if a != "--no-cors"]`), usage string `check_hosting.py [--no-cors] URL`, pass `cors=cors`. Docstring: add "`--no-cors`: same-origin deployments (the viewer is served next to its data), where only Range matters."

- [ ] **Step 4: Run, expect pass; commit**

Run: `tools/.venv/bin/pytest tools/tests -q` → all pass.
```bash
git add tools && git commit -m "check_hosting: --no-cors for same-origin hosts"
```

### Task 5: Harness theme from `?theme=` and same-origin `postMessage`

**Files:**
- Create: `src/harness.ts` (pure helpers) + `src/harness.test.ts`
- Modify: `src/App.tsx`, `vite.config.ts` (`test.include` gains `src/**/*.test.ts` already matches; nothing to change unless the pattern excludes `src/*.test.ts`)

**Interfaces:**
- Produces: `parseHarnessParams(search): { dataset, dpr, bench, theme }`, `themeFromMessage(ev: { origin, data }, own: string): 'dark' | 'light' | null`.

- [ ] **Step 1: Failing tests**

`src/harness.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseHarnessParams, themeFromMessage } from './harness'

describe('parseHarnessParams', () => {
  it('defaults', () => {
    expect(parseHarnessParams('')).toEqual({ dataset: 'demo', dpr: undefined, bench: false, theme: 'dark' })
  })
  it('validates dataset, clamps dpr, reads bench and theme', () => {
    expect(parseHarnessParams('?data=full&dpr=9&bench=1&theme=light')).toEqual({ dataset: 'full', dpr: 4, bench: true, theme: 'light' })
    expect(parseHarnessParams('?data=../x&dpr=0.1&theme=blue')).toEqual({ dataset: 'demo', dpr: 0.5, bench: false, theme: 'dark' })
  })
})

describe('themeFromMessage', () => {
  it('accepts a same-origin pcv-theme message and rejects everything else', () => {
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'pcv-theme', theme: 'light' } }, 'https://lab.merttoka.com')).toBe('light')
    expect(themeFromMessage({ origin: 'https://evil.example', data: { type: 'pcv-theme', theme: 'light' } }, 'https://lab.merttoka.com')).toBeNull()
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'other' } }, 'https://lab.merttoka.com')).toBeNull()
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'pcv-theme', theme: 'neon' } }, 'https://lab.merttoka.com')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run src/harness.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/harness.ts`**

```ts
// Dev/production harness helpers (outside src/viewer on purpose: the component parses no URLs).
export type Theme = 'dark' | 'light'
export interface HarnessParams { dataset: string; dpr: number | undefined; bench: boolean; theme: Theme }

const isTheme = (t: unknown): t is Theme => t === 'dark' || t === 'light'

export function parseHarnessParams(search: string): HarnessParams {
  const p = new URLSearchParams(search)
  const data = p.get('data') ?? ''
  const dprRaw = Number(p.get('dpr'))
  const theme = p.get('theme')
  return {
    dataset: /^[a-z0-9-]+$/.test(data) ? data : 'demo',
    dpr: Number.isFinite(dprRaw) && dprRaw > 0 ? Math.min(4, Math.max(0.5, dprRaw)) : undefined,
    bench: p.get('bench') === '1',
    theme: isTheme(theme) ? theme : 'dark',
  }
}

// The Lab page posts { type: 'pcv-theme', theme } into the iframe; only its own origin (the proxy makes them equal) counts.
export function themeFromMessage(ev: { origin: string; data: unknown }, ownOrigin: string): Theme | null {
  if (ev.origin !== ownOrigin) return null
  const d = ev.data as { type?: unknown; theme?: unknown } | null
  return d && d.type === 'pcv-theme' && isTheme(d.theme) ? d.theme : null
}
```

`src/App.tsx` becomes:
```tsx
import { useEffect, useState } from 'react'
import { PointCloudViewer, type BenchHandle } from './viewer/PointCloudViewer'
import { parseHarnessParams, themeFromMessage, type Theme } from './harness'

// Harness: `?data=<name>` picks `public/data/<name>/` (`full` = 20M set, `export` = a re-opened export); `?dpr=` overrides
// the canvas pixel ratio; `?bench=1` exposes window.__pcv; `?theme=` sets the initial theme, the Lab page updates it by postMessage.
const params = parseHarnessParams(window.location.search)
const attach = (h: BenchHandle) => { (window as unknown as { __pcv?: unknown }).__pcv = h }

export function App() {
  const [theme, setTheme] = useState<Theme>(params.theme)
  useEffect(() => {
    const on = (e: MessageEvent) => { const t = themeFromMessage(e, window.location.origin); if (t) setTheme(t) }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`${import.meta.env.BASE_URL}data/${params.dataset}/manifest.json`} dpr={params.dpr} theme={theme} onApi={params.bench ? attach : undefined} />
    </div>
  )
}
```
`index.html` stays as is: the viewer root paints its own `--pcv-bg`, so the `#111` body background only shows before React mounts.

- [ ] **Step 4: Gates + browser check** — `npx tsc --noEmit && npx vitest run` clean; `http://localhost:5173/?theme=light` renders the light palette (screenshot); `browser_evaluate` `() => { window.postMessage({ type: 'pcv-theme', theme: 'dark' }, location.origin); return true }` then a screenshot shows dark.

- [ ] **Step 5: Commit** — `git add src index.html && git commit -m "harness: params parser, theme via ?theme= and same-origin postMessage"`

### Task 6: Vercel project, base path, build-time data

**Files:**
- Modify: `vite.config.ts` (`base: '/point-cloud/app/'`), `package.json` (`"build:vercel": "npm run data:demo && npm run data:full && npm run build"`), `CLAUDE.md` (dev URL), `README.md` (dev URL, `?bench`, `?data=full`)
- Create: `vercel.json`

- [ ] **Step 1: Config**

`vite.config.ts`: add `base: '/point-cloud/app/',` to `defineConfig`. Vite writes `dist/index.html` + `dist/assets/` at the output root and *references* them under `base` (`/point-cloud/app/assets/…`), and `vite preview` serves `dist/` at the base path. Vercel serves `dist/` at `/`, so a rewrite maps the base prefix back onto the output root. `vercel.json`:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build:vercel",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [ { "source": "/point-cloud/app/:path*", "destination": "/:path*" } ],
  "headers": [
    { "source": "/point-cloud/app/data/(.*)", "headers": [
      { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" },
      { "key": "Access-Control-Allow-Origin", "value": "https://lab.merttoka.com" } ] }
  ]
}
```
`headers.source` matches the incoming request path (before the rewrite); after the first deploy confirm with `curl -sI https://point-cloud-editor.vercel.app/point-cloud/app/data/demo/manifest.json | grep -i 'cache-control\|access-control'` and, if the header is missing, add a second entry with `"source": "/data/(.*)"`. The CORS header is belt-and-braces: the Lab reaches the data through its proxy, same-origin. `package.json` scripts: add `"build:vercel": "npm run data:demo && npm run data:full && npm run build"`. Local check: `npm run build && npm run preview` → `http://localhost:4173/point-cloud/app/` renders the demo.

- [ ] **Step 2: Local verification**

`npm run build` clean → `npm run preview` → Playwright `http://localhost:4173/point-cloud/app/?bench=1` loads the demo (`typeof __pcv === 'object'` after wait); `http://localhost:4173/point-cloud/app/?data=full` loads 20M. `tools/.venv/bin/python tools/check_hosting.py --no-cors http://localhost:4173/point-cloud/app/data/demo/points.bin` → PASS range 206.

- [ ] **Step 3: User step — create the Vercel project (Hobby)**

No CLI (the `vercel` package is not an approved dependency and `npx` would fetch it). In the Vercel dashboard: *Add New → Project → Import `merttoka/point-cloud-editor`*, framework Vite, leave build settings (taken from `vercel.json`), project name `point-cloud-editor`, production branch `main`. Record the production URL (`https://point-cloud-editor.vercel.app` expected) in `docs/EMBEDDING.md` (Task 8). Deploys happen on push to `main`, so this becomes live at the phase merge; until then, a preview deploy from the branch can be triggered from the dashboard ("Deploy" on the branch) if the user wants an early check.

- [ ] **Step 4: After the first deploy — hosting check**

`tools/.venv/bin/python tools/check_hosting.py --no-cors https://point-cloud-editor.vercel.app/point-cloud/app/data/full/points.bin` → PASS range 206 + content-range (paste the verbatim output into ARCHITECTURE § Hosting in Task 9). Playwright: `https://point-cloud-editor.vercel.app/point-cloud/app/?bench=1` loads; `__pcv.loadMs()` recorded as the "internet" load-time note (not a README row).

- [ ] **Step 5: Docs + commit**

`CLAUDE.md` Environment: dev URL `http://localhost:5173/point-cloud/app/`. README § Setup/Usage: same URL, `?bench=1`, `?data=full`, `?theme=`.
```bash
git add vite.config.ts vercel.json package.json CLAUDE.md README.md && git commit -m "deploy: vercel project (base /point-cloud/app/, build-time data fetch), rewrites + data cache headers"
```

### Task 7: Measurement session (2M / 10M / 20M) + media

**Files:**
- Create/Modify: `docs/bench/2026-09-XX-m4max.json` (all three rows, `vite preview`, same session), `docs/media/{hero.webm,hero.mp4,overview.png,classification.png,normals-ao.png,lasso.png,split.png}`
- Modify: nothing in `src/` unless a bug shows (then test + fix + commit separately)

- [ ] **Step 1: Rows** — follow `scripts/bench.md` for demo, full@50 %, full@100 % from `npm run preview`. Record `rssDeltaKB` per row. Keep the JSON file under 20 KB (no arrays beyond `pickMs`).
- [ ] **Step 2: Hero + PNGs** — runbook § Media. Check sizes: `du -ch docs/media/*` ≤ 5 MB total; `hero.webm` ≤ 3 MB. If `record()` rejects in headless, use the PNG-sequence fallback and note it in `scripts/bench.md` § Media.
- [ ] **Step 3: Sanity** — every earlier README number (Phase 3–5 sections) within ±10 % of the new row, else investigate before publishing (a regression becomes a separate bounded task per spec; do not tune here).
- [ ] **Step 4: Commit** — `git add docs/bench docs/media scripts/bench.md && git commit -m "bench: 2M/10M/20M rows (headless, DPR 1), hero webm/mp4 + PNGs"`

### Task 8: `docs/EMBEDDING.md`, Lab wiring, toolchain spike

**Files:**
- Create: `docs/EMBEDDING.md`
- Lab repo (commit there, no push): `vercel.json`, `src/App.tsx`, `src/pages/Home.tsx`, `src/pages/Home.css`, `src/experiments/point-cloud/index.tsx`, `src/experiments/point-cloud/point-cloud.css`

**Interfaces:**
- Consumes: production URL from Task 6; Lab `LabHeader({ breadcrumbs })`, `useTheme().resolved`, `--header-height`.

- [ ] **Step 1: Toolchain spike (scratchpad, not committed)**

In the scratchpad: `npm create vite@latest pcv-embed -- --template react-ts` is **not** pinned to the Lab's versions; instead copy the Lab's `package.json`, `tsconfig.app.json`, `tsconfig.json`, `vite.config.ts`, `index.html` into `scratchpad/pcv-embed/`, then `npm install` and `npm install three@0.186.0 @react-three/fiber@9.7.0 @react-three/drei@10.7.8 fflate@0.8.3 @types/three@0.186.0` (no `.npmrc`: React 19.2.4 is inside fiber's peer range). Copy `src/viewer/` (excluding `*.test.ts`) to `scratchpad/pcv-embed/src/viewer/`, write `src/App.tsx` rendering `<PointCloudViewer manifestUrl="/data/demo/manifest.json" />`, symlink `public/data/demo` to this repo's copy. `npx tsc -b && npx vite build` must pass; `npx vite preview` renders the demo (Playwright screenshot). Record every deviation needed (a type flag, a `?raw` import declaration for `.wgsl` if the viewer imports any, `assetsInclude`) — they go in EMBEDDING § "Toolchain notes" verbatim.

- [ ] **Step 2: `docs/EMBEDDING.md`**

Sections, in this order: (1) **Two ways in**: proxy/iframe (what the Lab does; zero coupling) and component copy. (2) **Proxy/iframe**: the exact Lab `vercel.json` route (`{ "src": "/point-cloud/app/(.*)", "dest": "https://point-cloud-editor.vercel.app/point-cloud/app/$1" }` placed before `{ "handle": "filesystem" }`), iframe snippet with `?theme=` and the `postMessage({ type: 'pcv-theme', theme }, location.origin)` contract, `allow="fullscreen"`, focus note (click the canvas; keys are scoped to the viewer root, never the host page). (3) **Component copy**: copy `src/viewer/` (drop `*.test.ts`), deps table with exact pins + `@types/three@0.186.0`, `.npmrc` `legacy-peer-deps=true` needed only if the host pins `react ≥ 19.3`, props table (`manifestUrl`, `theme?`, `className?`, `dpr?`, `onApi?`), the `--pcv-*` token list with fallbacks (from `theme/tokens.module.css`), WebGPU-unsupported behaviour (message in the root, no throw), worker note (`new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })` is bundler-resolved by Vite; other bundlers need their worker plugin), toolchain notes from Step 1. (4) **Data**: manifest + `points.bin` next to each other, `Range` preferred, single-fetch fallback, `check_hosting.py [--no-cors] URL`, sizes (16 MB / 160 MB), the Vancouver OGL attribution line the host page must show. (5) **Bench handle**: `onApi` + `window.__pcv` pattern and a pointer to `scripts/bench.md`.

- [ ] **Step 3: Lab wiring (in `/Users/toka/Professional/Public/website/lab`; read its `CLAUDE.md` first)**

`vercel.json` routes, insert before `{ "handle": "filesystem" }`:
```json
    { "src": "/point-cloud/app/(.*)", "dest": "https://point-cloud-editor.vercel.app/point-cloud/app/$1" },
```
`src/experiments/point-cloud/index.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import LabHeader from '../../components/LabHeader'
import { useTheme } from '../../theme/ThemeProvider'
import './point-cloud.css'

const APP = '/point-cloud/app/'

export default function PointCloud() {
  const { resolved } = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  // The src is fixed at mount (a changing src would reload the viewer and its 16 MB); later toggles are posted
  // (same origin through the proxy) and the viewer switches palette in place.
  const [src] = useState(() => `${APP}?theme=${resolved}`)
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'pcv-theme', theme: resolved }, window.location.origin) }, [resolved])
  return (
    <div className="pcv-page">
      <LabHeader breadcrumbs={[{ label: 'Point Cloud Editor' }]} />
      <iframe ref={frame} className="pcv-frame" src={src} title="Point Cloud Editor" allow="fullscreen" />
      <p className="pcv-attribution">City of Vancouver LiDAR 2022 · Contains information licensed under the Open Government Licence – Vancouver. Source and docs: <a href="https://github.com/merttoka/point-cloud-editor">github.com/merttoka/point-cloud-editor</a>.</p>
    </div>
  )
}
```
`src/experiments/point-cloud/point-cloud.css`:
```css
.pcv-page { display: flex; flex-direction: column; min-height: 100vh; background: var(--bg); }
.pcv-frame { flex: 1; width: 100%; min-height: calc(100vh - var(--header-height) - 40px); border: 0; background: var(--bg); }
.pcv-attribution { margin: 0; padding: 10px 16px; font: 12px/1.5 var(--font-body); color: var(--text-muted); }
.pcv-attribution a { color: var(--text-secondary); }
```
`src/App.tsx`: `import PointCloud from './experiments/point-cloud/index.tsx'` and `<Route path="/point-cloud" element={<PointCloud />} />` after the editorial route. `src/pages/Home.tsx`: next to the editorial card add
```tsx
            <Link to="/point-cloud" className="home-card">
              <div className="home-card-preview preview-point-cloud">
                <span className="card-badge">20M points · WebGPU</span>
              </div>
              <div className="home-card-body">
                <h3 className="card-title">Point Cloud Editor</h3>
                <p className="card-description">Vancouver LiDAR in the browser: streaming, GPU normals + AO, lasso editing, export.</p>
              </div>
            </Link>
```
(match the editorial card's exact inner markup — copy its structure, replace the text). `Home.css` after `.preview-editorial`:
```css
.preview-point-cloud {
  background:
    radial-gradient(circle at 30% 40%, rgba(191,22,86,0.35) 0 1px, transparent 1.5px 9px),
    repeating-radial-gradient(circle at 70% 60%, rgba(224,224,224,0.22) 0 1px, transparent 1px 7px),
    linear-gradient(160deg, #101418 0%, #0d0d0f 100%);
}
```
Verify: `npm run build` in the Lab passes; `npm run dev` → `http://localhost:5173/point-cloud` shows the header + iframe (locally the proxy does not exist, so the iframe 404s — expected; the production check is Step 4). Commit in the Lab: `point-cloud: route + card, proxy /point-cloud/app/ to point-cloud-editor`. **Do not push.**

- [ ] **Step 4: Production check (after the user pushes the Lab, whenever that is)**

`https://lab.merttoka.com/point-cloud` → iframe loads the demo; theme toggle switches the viewer without a reload (network tab shows no second `manifest.json`); `check_hosting.py --no-cors https://lab.merttoka.com/point-cloud/app/data/full/points.bin` → note `range 206` PASS or the 200 fallback in ARCHITECTURE § Hosting. This step can land after the merge; record the outcome in `docs/ARCHITECTURE.md` when it does.

- [ ] **Step 5: Commit (this repo)** — `git add docs/EMBEDDING.md && git commit -m "docs: EMBEDDING (proxy/iframe + component copy, toolchain notes from the Lab-versions spike)"`

### Task 9: README rewrite, ARCHITECTURE final, master spec status

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md`

- [ ] **Step 1: README** — final structure per spec + P6-8: hero (`<video src="docs/media/hero.webm">` with `hero.mp4` fallback and `overview.png` poster; GitHub renders a plain link, so also a direct `docs/media/hero.webm` link), what it is (3 lines) + portfolio blurb (3–5 sentences), **Live**: `https://lab.merttoka.com/point-cloud`, Controls table (moved from the current README unchanged), Setup (`npm install`, `npm run data:demo`, `npm run dev` → `http://localhost:5173/point-cloud/app/`; WebGPU requirement; `?data=full`, `?bench=1`, `?dpr=`, `?theme=`), Data (source tile, OGL Vancouver line, preprocess pointer, `data:full`), Performance table (one row per dataset, columns: load ms, frame ms/fps default → post-orbit, draws, EDL off/on ms, render GPU ms, compute total GPU ms, lasso GPU/readback ms, pick ms median; header states machine, Chromium, DPR 1, headless, date, and the `docs/bench/<file>.json` it comes from), compute per-pass table (from `compute.*`), CPU bench/verify line (demo), Memory table (computed buffers per `memory.*` vs `rssDeltaKB`), Architecture summary (5 bullets + link), Embedding (2 lines + link), Licence + attribution. **Delete** the Status section and the Phase 0 spike table (they live in ARCHITECTURE).
- [ ] **Step 2: ARCHITECTURE** — new top section `## Overview` with the ASCII data-flow diagram (LAZ → `preprocess.py` → release assets → `fetch-data.mjs` / Vercel build → `public/data` → loader worker (Range) → `qpos`/`flags` storage buffers → render (sprites, EDL) / compute (hash → scan → scatter → normals → AO) / edit (pick, lasso, ops, undo) → export zip), then `## Deferred` (triage: mark the `id="hud"` item done, the EDL timestamp item done via `renderGpuMs`, hosting item replaced by the Vercel + proxy description with the `check_hosting.py` outputs, single-encoder and renderer-disposal items kept with owner "any"), new `## Bench and deploy (phase 6)` (handle design: `onApi`, `BenchHooks`, why `runAll` is in-page; `renderGpuMs` semantics: RENDER timestamp sum over the frame's passes; measured rows summary citing the JSON; hosting: Vercel rewrites, proxy result; media pipeline), existing per-phase sections kept verbatim. Grep gate: every file/buffer/pass name mentioned exists (`grep -o` the backticked identifiers in the new sections against `src/`).
- [ ] **Step 3: Master spec** — phase list items 3–6 → `**Done.**`; status line → `Status: complete (2026-09-XX)`; `Amendment A11`: "Lab integration = proxy + iframe (phase 6 spec P6-1), data via build-time fetch (P6-2)".
- [ ] **Step 4: Commit** — `git add README.md docs && git commit -m "docs: README final (live URL, perf/memory tables from docs/bench), ARCHITECTURE overview + phase 6, master spec complete"`

### Task 10: Gates, merge, deslop

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run && npm run build && tools/.venv/bin/pytest tools/tests -q` → all green; `grep -rn '__pcv\|import.meta.env.DEV' src/viewer` → empty.
- [ ] **Step 2:** Whole-branch review (subagent-driven-development's final review), fix rounds committed.
- [ ] **Step 3:** `git checkout main && git merge --no-ff phase-6-perf-docs -m "merge phase-6-perf-docs" && git push origin main && git branch -d phase-6-perf-docs` — the push is the production deploy of the standalone project (Task 6 project must exist first).
- [ ] **Step 4:** `/deslop` over `src/viewer/bench/`, `src/harness.ts`, `src/App.tsx`, `src/viewer/ui/Hud.tsx`, `src/viewer/render/Scene.tsx`, `src/viewer/loader/useLoader.ts`, `src/viewer/compute/ComputeRunner.tsx`, `src/viewer/render/PostPass.tsx`; commit to `main`.
- [ ] **Step 5:** Tell the user the Lab commit is waiting to be pushed (Task 8 Step 3) and what Task 8 Step 4 checks once it is.

## Unresolved questions

✅ No unresolved questions.
