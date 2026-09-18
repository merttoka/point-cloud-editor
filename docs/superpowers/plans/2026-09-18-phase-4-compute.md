# Phase 4: Compute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPU normals + ambient occlusion over all loaded points (spatial hash → kNN/PCA normals → tangent-plane AO) in raw WGSL, with per-pass timings in the panel, three shading modes that consume them, and a CPU implementation of the same algorithms used as a benchmark and correctness oracle (Verify).

**Architecture:** `createPointBuffers` grows two zero-filled storage attributes (`normals u32[N]` oct-encoded, `ao u32[ceil(N/4)]` u8-packed) that the vertex stage reads through `vertexStage()` for `lit` / `lit + AO` shading. `compute/pipeline.ts` owns the hash-table buffers (`cellStart`, `cellCursor`, `blockSums`, `sorted`) and six `wgslFn` kernels (zero, count, 3× scan, scatter, normals, ao) sharing one WGSL helper block; each pass is `computeAsync` + `resolveTimestampsAsync`. A `<ComputeRunner>` inside `<Canvas>` exposes `api.build/readback`; the loader worker gains `cpuBench` (same algorithms in TS over typed arrays); `compute/verify.ts` compares readbacks. All UI state lives in the store; the panel gains "Compute" and "Benchmark" groups.

**Tech Stack:** three 0.186.0 (`three/webgpu`, `three/tsl`: `wgslFn`, `wgsl`, `storage().toAtomic()`, `instanceIndex`, `computeAsync`, `resolveTimestampsAsync`, `getArrayBufferAsync`), R3F 9.7.0, React 19.3.0, vitest (node), Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-4-compute-design.md` (parent §3, amendments A3, A4, A6, A9). Drift notes: `docs/superpowers/specs/2026-09-17-spec-review-phases-3-6.md` § Phase 4.

## Rulings on the spec-review items (Phase 4 §1–10) and spec deviations

| # | Ruling |
|---|---|
| 1 Dequant sharing | No new module. Kernels take `dqScale` as a `vec3<f32>` parameter built from the existing `dequantScale(manifest.bounds)` (`format/quant.ts`); the material keeps its own uniform from the same function. Kernels work in bounds-relative coordinates (`q × dqScale`, no centroid), so cell coordinates are non-negative. Phase 5 pick reuses the same source. |
| 2 normals/ao buffers | Option (a): allocated zero-filled in `createPointBuffers` (+100 MB at 20M up front). Lit modes are gated on `compute.status === 'built'` in the panel, and the material forces `flat` until then, so zero-filled buffers are never displayed. |
| 3 flags | Compute never reads `flags`; hidden/deleted points are included in neighbourhoods (spec). |
| 4 Worker reuse | `cpuBench` / `cancelBench` join `LoaderIn`; `benchProgress` / `benchDone` / `benchCancelled` join `LoaderOut`. Same worker, alive after `done`. |
| 5 Build gating | Build button enabled when `status === 'ready'` and (`compute.status !== 'built'` or the radius changed since the build). |
| 6 Zeroing | Not by CPU upload: a `zeroCells` kernel (`atomicStore(&cellStart[i], 0u)`) runs first in every build; no 16.8 MB upload. |
| 7 Timing | Only the `resolveTimestampsAsync` promise result is used; `info.compute` is never read. |
| 8 Limits | Unchanged; 80 MB buffers < 256 MiB `maxBufferSize`. Documented in ARCHITECTURE. |
| 9 Spacing | `spacing = sqrt(areaXY / pointCount)` with the manifest's full count; the build always runs over all N regardless of the render budget (stated in panel help text and docs). |
| 10 k fallback | `K = 16` constant in `compute/params.ts`; the register-pressure fallback is a one-line change, documented. Hash occupancy is read back at 2M and recorded. |

Extra rulings made while checking the spec against three 0.186 and the shipped code:
- **Scan without workgroup memory.** Reduce-then-scan stays three dispatches, but each is thread-per-block with a serial 256-entry loop (`reduceBlocks` over `T/256` threads, `scanBlockSums` on one thread over ≤ 16,384 sums, `scanCells` over `T/256` threads writing `cellStart`, `cellCursor` and `cellStart[T] = N`). No `var<workgroup>`, no barriers; at T = 2²² this is ~8 M serial adds total — negligible. Fewer moving parts than a shared-memory scan and vitest-verifiable through the CPU mirror.
- **One atomic node per atomic buffer.** `cellStart`/`cellCursor` are `storage(attr, 'uint', n).toAtomic()` everywhere; kernels that only read or plainly write them use `atomicLoad` / `atomicStore` (WGSL has no non-atomic access to `array<atomic<u32>>`). Avoids two `StorageBufferNode`s over one attribute. Fallback if the spike shows a problem: a second plain `storage()` node over the same attribute for the non-atomic kernels.
- **Shared WGSL helpers** (`decodePos`, `cellKey`, `octEncode`, `octDecode`, `smallestEigenvector`) live in one `wgsl()` code node passed as `includes` to every `wgslFn` (`three/tsl` `wgslFn(src, [wgsl(helpers)])`).
- **Hash buffers stay allocated** after a build (the spec's "freed after the build" has no three API; `cellCursor`/`blockSums` are 17 MB at 20M). Rebuilds reuse them.
- **Verify needs the same point set on both sides**, so it is enabled only when `pointCount ≤ BENCH_CAP` (2M — the demo set). On the full set the CPU bench runs on a per-chunk prefix subsample for timing only and Verify is disabled with a note. Acceptance ("Verify at 2M") is unaffected.
- **Jacobi**: 3×3 symmetric, cyclic, 8 sweeps, classic NR rotation (`a_pp -= t·a_pq`, `a_qq += t·a_pq`, off-diagonals via `c/s`), identical in WGSL and TS.
- **PCA includes the point itself** with its ≤ 16 neighbours (n + 1 samples); degenerate when fewer than 3 neighbours or the two smallest eigenvalues differ by < 1e-6.
- **Dev handle**: `window.__pcvCompute = { build, readback }` under `import.meta.env.DEV` for the Playwright checks (Phase 6 folds every dev global into `window.__pcv` behind `?bench=1`).
- **Panel** gets the `api` prop (build/bench/verify are imperative); the two new groups reuse `.group` / `.groupTitle`.

## Global Constraints

- Pinned deps only (`three@0.186.0`, fiber `9.7.0`, drei `10.7.8`, react `19.3.0`, vite `8.3.0`); no new runtime deps.
- WebGPU only. Compute = raw WGSL via `wgslFn` + `storage()` nodes. **Every kernel returns a `u32` and its call is `.toVar()`-ed** (void `wgslFn` calls are dropped by three 0.186). Never `toReadOnly()` on a shared storage node. Point-parallel kernels: `instanceIndex` with an `i >= count` guard, `.compute(N, [64])` (three splits > 65,535 workgroups itself, A9). Flags/`ao` writes are thread-per-word.
- Hidden/deleted points collapse the quad (`sizeNode = 0`) — unchanged. Everything derived from the point index inside `colorNode` goes through `vertexStage()`.
- `src/viewer/` self-contained; CSS modules; `--pcv-*` tokens; keys on the viewer root only.
- vitest runs in node: `compute/cpu/*`, `compute/params.ts`, `compute/verify.ts` are pure; kernels/pipeline verified in the browser with Playwright MCP (`browser_navigate`, `browser_evaluate`, `browser_wait_for`, `browser_console_messages`, `browser_take_screenshot`). Don't poll the page in tight loops while 160 MB streams.
- Console clean: 0 errors; only the two benign warnings.
- Data: `public/data/{demo,full}` present (`npm run data:demo`, `data:full`). Dev harness: `?data=full`.
- Branch `phase-4-compute` from `main`. Commit messages concise, no attribution lines.

---

### Task 0: Branch, buffers, store, params

**Files:**
- Modify: `src/viewer/render/PointBuffers.ts`
- Modify: `src/viewer/state/store.ts`
- Create: `src/viewer/compute/params.ts`
- Test: `src/viewer/render/PointBuffers.test.ts`, `src/viewer/state/store.test.ts`, `src/viewer/compute/params.test.ts`

**Interfaces:**
- Produces on `PointBuffers`: `normals: StorageBufferAttribute` (`Uint32Array(count)`), `ao: StorageBufferAttribute` (`Uint32Array(ceil(count/4))`), `normalsNode: StorageBufferNode<'uint'>`, `aoNode: StorageBufferNode<'uint'>`.
- Produces in store: `Shading = 'flat' | 'lit' | 'litAo'`; `PassTiming { pass: string; submitMs: number; gpuMs: number | null }`; `ComputeState { status: 'idle' | 'running' | 'built' | 'error'; radiusMul: number; builtRadius: number | null; timings: PassTiming[]; elapsedMs: number | null; error?: string }`; `BenchState { status: 'idle' | 'running' | 'done' | 'cancelled'; progress: number; n: number; cpuMs: { hash: number; normals: number; ao: number } | null; verify: VerifyResult | null }`; `VerifyResult { n: number; medianDeg: number; maxDeg: number; aoMae: number; nonFinite: number; degenerate: number }`; `ViewerState.shading`, `.compute`, `.bench`.
- Produces in `compute/params.ts`: `K = 16`, `BENCH_CAP = 2_000_000`, `SCAN_BLOCK = 256`, `EPS_MUL = 0.02`, `PASSES = ['count', 'scan', 'scatter', 'normals', 'ao'] as const`, `spacingOf(bounds, pointCount): number`, `tableSizeFor(pointCount): number` (`nextPow2(max(1024, ceil(N / 8)))`), `benchWords(words: Uint32Array, chunks: { offset: number; count: number }[], n: number): Uint32Array` (first `floor(n / chunks.length)` points of every chunk, contiguous; the whole array when `n >= total`).

- [ ] **Step 1: Branch**

```bash
cd ~/Developer/Graphics/TS_PointCloud && git checkout main && git pull -q && git checkout -b phase-4-compute
```

- [ ] **Step 2: Failing tests**

Append to `src/viewer/render/PointBuffers.test.ts` (inside the existing `describe`):

```ts
  it('allocates zero-filled normals (N words) and ao (ceil(N/4) words) storage', () => {
    const b = createPointBuffers(10, 1)
    expect(b.normals.array.length).toBe(10)
    expect(b.ao.array.length).toBe(3)
    expect(b.normals.itemSize).toBe(1)
    expect(Array.from(b.normals.array as Uint32Array).every((v) => v === 0)).toBe(true)
    expect(b.normalsNode).toBeDefined()
    expect(b.aoNode).toBeDefined()
  })
```

Append to `src/viewer/state/store.test.ts`:

```ts
  it('phase 4 defaults: flat shading, compute idle at 3× spacing, bench idle', () => {
    const s = createStore(initialState)
    expect(s.get().shading).toBe('flat')
    expect(s.get().compute).toEqual({ status: 'idle', radiusMul: 3, builtRadius: null, timings: [], elapsedMs: null })
    expect(s.get().bench).toEqual({ status: 'idle', progress: 0, n: 0, cpuMs: null, verify: null })
  })
```

Create `src/viewer/compute/params.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spacingOf, tableSizeFor, benchWords, BENCH_CAP, K } from './params'

describe('params', () => {
  it('spacing is sqrt(areaXY / N)', () => {
    expect(spacingOf({ min: [0, 0, 0], max: [1000, 1000, 100] }, 2_000_000)).toBeCloseTo(Math.sqrt(1e6 / 2e6), 12)
  })
  it('table size is nextPow2(max(1024, N/8))', () => {
    expect(tableSizeFor(100)).toBe(1024)
    expect(tableSizeFor(2_000_000)).toBe(262144)
    expect(tableSizeFor(20_000_000)).toBe(4194304)
  })
  it('benchWords takes an equal prefix of every chunk, contiguous', () => {
    const words = new Uint32Array(20)            // 10 points, 2 chunks of 5
    for (let i = 0; i < 20; i++) words[i] = i
    const chunks = [{ offset: 0, count: 5 }, { offset: 5, count: 5 }]
    const sub = benchWords(words, chunks, 4)     // 2 per chunk
    expect(Array.from(sub)).toEqual([0, 1, 2, 3, 10, 11, 12, 13])
    expect(benchWords(words, chunks, 10)).toBe(words)   // n >= total: same array, no copy
    const uneven = [{ offset: 0, count: 1 }, { offset: 1, count: 1 }, { offset: 2, count: 8 }]
    expect(Array.from(benchWords(words, uneven, 6))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])   // short chunks are not padded
  })
  it('constants', () => { expect(K).toBe(16); expect(BENCH_CAP).toBe(2_000_000) })
})
```

Run: `npx vitest run src/viewer/render/PointBuffers.test.ts src/viewer/state/store.test.ts src/viewer/compute/params.test.ts` → FAIL (missing fields / module).

- [ ] **Step 3: Implement**

`src/viewer/render/PointBuffers.ts` — add fields to the interface after `flagsNode`:

```ts
  normals: StorageBufferAttribute   // oct-encoded normal per point (2 × u16), written by compute
  ao: StorageBufferAttribute        // u8 per point packed 4/word, written by compute (thread-per-word)
  normalsNode: StorageBufferNode<'uint'>
  aoNode: StorageBufferNode<'uint'>
```

In `createPointBuffers`, after `flags`:

```ts
  const normals = new StorageBufferAttribute(new Uint32Array(count), 1)
  const ao = new StorageBufferAttribute(new Uint32Array(flagWords), 1)
  const normalsNode = storage(normals, 'uint', count)
  const aoNode = storage(ao, 'uint', flagWords)
```

Return them (`count, qpos, flags, normals, ao, qposNode, flagsNode, normalsNode, aoNode,`) and add `normalsNode.dispose(); aoNode.dispose()` to `dispose()`.

`src/viewer/state/store.ts` — add after `EdlState`:

```ts
export type Shading = 'flat' | 'lit' | 'litAo'
export interface PassTiming { pass: string; submitMs: number; gpuMs: number | null }
export interface ComputeState {
  status: 'idle' | 'running' | 'built' | 'error'
  radiusMul: number            // slider, × spacing
  builtRadius: number | null   // metres, radius the current normals/ao were built with
  timings: PassTiming[]
  elapsedMs: number | null
  error?: string
}
export interface VerifyResult { n: number; medianDeg: number; maxDeg: number; aoMae: number; nonFinite: number; degenerate: number }
export interface BenchState {
  status: 'idle' | 'running' | 'done' | 'cancelled'
  progress: number             // 0..1
  n: number
  cpuMs: { hash: number; normals: number; ao: number } | null
  verify: VerifyResult | null
}
```

`ViewerState` gains `shading: Shading`, `compute: ComputeState`, `bench: BenchState`; `initialState` gains:

```ts
  shading: 'flat',
  compute: { status: 'idle', radiusMul: 3, builtRadius: null, timings: [], elapsedMs: null },
  bench: { status: 'idle', progress: 0, n: 0, cpuMs: null, verify: null },
```

Create `src/viewer/compute/params.ts`:

```ts
import type { Bounds } from '../format/quant'
import { WORDS_PER_POINT } from '../format/quant'

export const K = 16                       // neighbours kept per point (drop to 12 if the normals kernel spills)
export const EPS_MUL = 0.02               // AO tangent-plane threshold = EPS_MUL × radius
export const BENCH_CAP = 2_000_000        // CPU benchmark / Verify point cap
export const SCAN_BLOCK = 256             // cells per scan block (serial per thread)
export const PASSES = ['count', 'scan', 'scatter', 'normals', 'ao'] as const

export function spacingOf(b: Bounds, pointCount: number): number {
  return Math.sqrt(((b.max[0] - b.min[0]) * (b.max[1] - b.min[1])) / pointCount)
}

// Hash table size (A4): nextPow2(max(1024, N/8)). Collisions merge cells; the distance test filters.
export function tableSizeFor(pointCount: number): number {
  let t = 1024
  while (t < pointCount / 8) t *= 2
  return t
}

// Bench subset on sets larger than the cap: the first floor(n / chunks) points of every chunk, packed contiguously.
export function benchWords(words: Uint32Array, chunks: { offset: number; count: number }[], n: number): Uint32Array {
  const total = words.length / WORDS_PER_POINT
  if (n >= total) return words
  const per = Math.floor(n / chunks.length)
  const out = new Uint32Array(per * chunks.length * WORDS_PER_POINT)
  let written = 0
  for (const c of chunks) {                     // chunks shorter than `per` contribute fewer points; never pad
    const take = Math.min(per, c.count) * WORDS_PER_POINT
    out.set(words.subarray(c.offset * WORDS_PER_POINT, c.offset * WORDS_PER_POINT + take), written)
    written += take
  }
  return written === out.length ? out : out.slice(0, written)
}
```

- [ ] **Step 4: Run, expect pass; commit**

`npx vitest run && npx tsc --noEmit` → green.

```bash
git add src/viewer/render/PointBuffers.ts src/viewer/render/PointBuffers.test.ts src/viewer/state/store.ts src/viewer/state/store.test.ts src/viewer/compute/params.ts src/viewer/compute/params.test.ts
git commit -m "phase 4: normals/ao buffers, compute/bench store state, params"
```

---

### Task 1: CPU spatial hash (reference for count / scan / scatter / kNN)

**Files:**
- Create: `src/viewer/compute/cpu/hash.ts`
- Test: `src/viewer/compute/cpu/hash.test.ts`

**Interfaces:**
- Produces: `decodePositions(words: Uint32Array, n: number, dqScale: [number, number, number]): Float32Array` (n×3, bounds-relative metres — the same `q × dqScale` the kernels use); `cellKey(cx, cy, cz, mask): number` (`(cx·73856093 ^ cy·19349663 ^ cz·83492791) & mask`, u32 wrapping); `exclusiveScan(counts: Uint32Array): Uint32Array` (length + 1, last = total); `buildGrid(pos: Float32Array, n, radius, T): Grid` where `Grid { cellStart: Uint32Array /* T+1 */; sorted: Uint32Array /* n */; radius: number; mask: number }`; `forEachNeighbour(grid, pos, i, r2, visit: (j: number, d2: number) => void)`; `knn(grid, pos, i, k): { idx: Uint32Array; d2: Float32Array; n: number }` (nearest ≤ k within radius, ascending d2, excluding i, insertion-sorted exactly like the kernel).

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { cellKey, exclusiveScan, buildGrid, knn, decodePositions, forEachNeighbour } from './hash'
import { packWords } from '../../format/quant'

function rand(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
function cloud(n: number, seed = 1): Float32Array {
  const r = rand(seed), p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { p[i * 3] = r() * 100; p[i * 3 + 1] = r() * 100; p[i * 3 + 2] = r() * 10 }
  return p
}

describe('cellKey', () => {
  it('wraps like u32 arithmetic and masks', () => {
    expect(cellKey(0, 0, 0, 1023)).toBe(0)
    expect(cellKey(1, 0, 0, 0xffffffff)).toBe(73856093)
    expect(cellKey(60000, 60000, 60000, 1023)).toBeLessThan(1024)
  })
})

describe('exclusiveScan', () => {
  it('matches a running reduce and ends with the total', () => {
    const c = new Uint32Array([3, 0, 5, 1])
    expect(Array.from(exclusiveScan(c))).toEqual([0, 3, 3, 8, 9])
    const r = rand(7), big = new Uint32Array(4096).map(() => Math.floor(r() * 10))
    const s = exclusiveScan(big)
    let acc = 0
    for (let i = 0; i < big.length; i++) { expect(s[i]).toBe(acc); acc += big[i] }
    expect(s[big.length]).toBe(acc)
  })
})

describe('buildGrid', () => {
  it('cellStart[T] == n and every point appears once in sorted', () => {
    const n = 5000, pos = cloud(n), g = buildGrid(pos, n, 2, 1024)
    expect(g.cellStart[1024]).toBe(n)
    expect(Array.from(g.sorted).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
  })
  it('forEachNeighbour visits exactly the points within radius', () => {
    const n = 3000, pos = cloud(n, 3), r = 3, g = buildGrid(pos, n, r, 1024)
    for (const i of [0, 17, 999, 2999]) {
      const got = new Set<number>()
      forEachNeighbour(g, pos, i, r * r, (j) => got.add(j))
      const want = new Set<number>()
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
        if (dx * dx + dy * dy + dz * dz <= r * r) want.add(j)
      }
      expect(got).toEqual(want)
    }
  })
})

describe('knn', () => {
  it('returns the same neighbour set as brute force (10k points, k=16)', () => {
    const n = 10000, pos = cloud(n, 5), r = 2.5, g = buildGrid(pos, n, r, 2048)
    for (const i of [0, 123, 4567, 9999]) {
      const res = knn(g, pos, i, 16)
      const brute = [] as { j: number; d2: number }[]
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 <= r * r) brute.push({ j, d2 })
      }
      brute.sort((a, b) => a.d2 - b.d2)
      const want = brute.slice(0, 16).map((b) => b.j)
      expect(res.n).toBe(want.length)
      expect(new Set(Array.from(res.idx.subarray(0, res.n)))).toEqual(new Set(want))
      for (let m = 1; m < res.n; m++) expect(res.d2[m]).toBeGreaterThanOrEqual(res.d2[m - 1])
    }
  })
})

describe('decodePositions', () => {
  it('is q × dqScale per axis', () => {
    const [w0, w1] = packWords(65535, 0, 32768, 0)
    const p = decodePositions(new Uint32Array([w0, w1]), 1, [0.01, 0.02, 0.03])
    expect(p[0]).toBeCloseTo(655.35, 4); expect(p[1]).toBe(0); expect(p[2]).toBeCloseTo(983.04, 4)
  })
})
```

Run: `npx vitest run src/viewer/compute/cpu/hash.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `cpu/hash.ts`**

```ts
import { K } from '../params'

// CPU mirror of hash.wgsl.ts: same key, same cell = floor(p / radius) in bounds-relative metres, same
// insertion-sorted kNN. Reference for the GPU readback in Verify and the algorithm the benchmark times.

export interface Grid { cellStart: Uint32Array; sorted: Uint32Array; radius: number; mask: number }

export function decodePositions(words: Uint32Array, n: number, dqScale: [number, number, number]): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const w0 = words[i * 2], w1 = words[i * 2 + 1]
    out[i * 3] = (w0 & 0xffff) * dqScale[0]
    out[i * 3 + 1] = (w0 >>> 16) * dqScale[1]
    out[i * 3 + 2] = (w1 & 0xffff) * dqScale[2]
  }
  return out
}

export function cellKey(cx: number, cy: number, cz: number, mask: number): number {
  const h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0
  return (h & mask) >>> 0
}

export function exclusiveScan(counts: Uint32Array): Uint32Array {
  const out = new Uint32Array(counts.length + 1)
  let acc = 0
  for (let i = 0; i < counts.length; i++) { out[i] = acc; acc += counts[i] }
  out[counts.length] = acc
  return out
}

function keyOf(pos: Float32Array, i: number, radius: number, mask: number): number {
  return cellKey(Math.floor(pos[i * 3] / radius), Math.floor(pos[i * 3 + 1] / radius), Math.floor(pos[i * 3 + 2] / radius), mask)
}

export function buildGrid(pos: Float32Array, n: number, radius: number, T: number): Grid {
  const mask = T - 1
  const counts = new Uint32Array(T)
  for (let i = 0; i < n; i++) counts[keyOf(pos, i, radius, mask)]++
  const cellStart = exclusiveScan(counts)
  const cursor = cellStart.slice(0, T)
  const sorted = new Uint32Array(n)
  for (let i = 0; i < n; i++) sorted[cursor[keyOf(pos, i, radius, mask)]++] = i
  return { cellStart, sorted, radius, mask }
}

export function forEachNeighbour(g: Grid, pos: Float32Array, i: number, r2: number, visit: (j: number, d2: number) => void): void {
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  const cx = Math.floor(px / g.radius), cy = Math.floor(py / g.radius), cz = Math.floor(pz / g.radius)
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = cx + dx, y = cy + dy, z = cz + dz
    if (x < 0 || y < 0 || z < 0) continue
    const key = cellKey(x, y, z, g.mask)
    for (let s = g.cellStart[key], end = g.cellStart[key + 1]; s < end; s++) {
      const j = g.sorted[s]
      if (j === i) continue
      const ex = pos[j * 3] - px, ey = pos[j * 3 + 1] - py, ez = pos[j * 3 + 2] - pz
      const d2 = ex * ex + ey * ey + ez * ez
      if (d2 <= r2) visit(j, d2)
    }
  }
}

export function knn(g: Grid, pos: Float32Array, i: number, k = K): { idx: Uint32Array; d2: Float32Array; n: number } {
  const idx = new Uint32Array(k), d2s = new Float32Array(k)
  let n = 0
  forEachNeighbour(g, pos, i, g.radius * g.radius, (j, d2) => {
    if (n < k) {
      let m = n
      while (m > 0 && d2s[m - 1] > d2) { d2s[m] = d2s[m - 1]; idx[m] = idx[m - 1]; m-- }
      d2s[m] = d2; idx[m] = j; n++
    } else if (d2 < d2s[k - 1]) {
      let m = k - 1
      while (m > 0 && d2s[m - 1] > d2) { d2s[m] = d2s[m - 1]; idx[m] = idx[m - 1]; m-- }
      d2s[m] = d2; idx[m] = j
    }
  })
  return { idx, d2: d2s, n }
}
```

- [ ] **Step 3: Run, expect pass; commit**

`npx vitest run src/viewer/compute/cpu/hash.test.ts` → 6 tests PASS.

```bash
git add src/viewer/compute/cpu/hash.ts src/viewer/compute/cpu/hash.test.ts
git commit -m "compute: cpu spatial hash, scan and knn reference"
```

---

### Task 2: CPU normals (covariance, Jacobi, oct encoding)

**Files:**
- Create: `src/viewer/compute/cpu/normals.ts`
- Test: `src/viewer/compute/cpu/normals.test.ts`

**Interfaces:**
- Produces: `jacobiEigen(m: number[] /* 9, row-major symmetric */): { values: [number, number, number]; vectors: number[] /* 9 row-major, column k = eigenvector k */ }`; `smallestEigenvector(m: number[]): [number, number, number] | null` (null when the two smallest eigenvalues differ by < 1e-6); `octEncode(n: [number, number, number]): number` (u32, `x | y << 16`, each `round((p·0.5 + 0.5)·65535)`); `octDecode(w: number): [number, number, number]` (unit); `normalAt(grid, pos, i): [number, number, number]` (+Z-oriented unit normal, or `[0,0,1]` when degenerate); `computeNormals(grid, pos, end, out?: Uint32Array, start = 0, onSlice?: (done: number) => void): Uint32Array` (oct words; fills `[start, end)` of `out`).

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { jacobiEigen, smallestEigenvector, octEncode, octDecode, normalAt, computeNormals } from './normals'
import { buildGrid } from './hash'

const angleDeg = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI

describe('jacobiEigen', () => {
  it('diagonal matrix: eigenvalues are the diagonal, vectors the axes', () => {
    const { values, vectors } = jacobiEigen([3, 0, 0, 0, 1, 0, 0, 0, 2])
    const sorted = [...values].sort((a, b) => a - b)
    expect(sorted[0]).toBeCloseTo(1, 10); expect(sorted[1]).toBeCloseTo(2, 10); expect(sorted[2]).toBeCloseTo(3, 10)
    const kMin = values.indexOf(sorted[0])
    expect(Math.abs(vectors[3 + kMin])).toBeCloseTo(1, 10)     // column kMin = ±(0,1,0)
  })
  it('known symmetric matrix', () => {
    const m = [2, 1, 0, 1, 2, 0, 0, 0, 3]                        // eigenvalues 1, 3, 3
    const { values, vectors } = jacobiEigen(m)
    const sorted = [...values].sort((a, b) => a - b)
    expect(sorted[0]).toBeCloseTo(1, 5); expect(sorted[1]).toBeCloseTo(3, 5); expect(sorted[2]).toBeCloseTo(3, 5)
    const k = values.indexOf(sorted[0])
    const v = [vectors[k], vectors[3 + k], vectors[6 + k]]
    expect(angleDeg(v, [1, -1, 0].map((x) => x / Math.SQRT2))).toBeLessThan(1e-3)
  })
})

describe('smallestEigenvector', () => {
  it('null when the two smallest eigenvalues coincide', () => {
    expect(smallestEigenvector([1, 0, 0, 0, 1, 0, 0, 0, 5])).toBeNull()
  })
  it('unit vector otherwise', () => {
    const v = smallestEigenvector([3, 0, 0, 0, 1, 0, 0, 0, 2])!
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
    expect(Math.abs(v[1])).toBeCloseTo(1, 10)
  })
})

describe('oct encode/decode', () => {
  it('round-trips unit vectors within 0.5°', () => {
    let seed = 3
    const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1 }
    let worst = 0
    for (let t = 0; t < 2000; t++) {
      const v = [r(), r(), r()]; const l = Math.hypot(...v); if (l < 1e-3) continue
      const n = v.map((x) => x / l) as [number, number, number]
      worst = Math.max(worst, angleDeg(n, octDecode(octEncode(n))))
    }
    expect(worst).toBeLessThan(0.5)
  })
  it('+Z encodes to the centre of the square', () => {
    expect(octEncode([0, 0, 1])).toBe((32768 | (32768 << 16)) >>> 0)
  })
})

describe('normalAt / computeNormals', () => {
  function plane(n: number, tilt: [number, number, number]) {
    // points on a plane through the origin with normal `tilt` (unit), jittered along the plane only
    const [a, b, c] = tilt
    const u = Math.abs(a) < 0.9 ? [0, c, -b] : [-c, 0, a]       // a vector orthogonal to tilt
    const ul = Math.hypot(...u); const U = u.map((x) => x / ul)
    const V = [b * U[2] - c * U[1], c * U[0] - a * U[2], a * U[1] - b * U[0]]
    const pos = new Float32Array(n * 3)
    let s = 11; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    for (let i = 0; i < n; i++) {
      const x = r() * 20, y = r() * 20
      pos[i * 3] = 30 + x * U[0] + y * V[0]; pos[i * 3 + 1] = 30 + x * U[1] + y * V[1]; pos[i * 3 + 2] = 30 + x * U[2] + y * V[2]
    }
    return pos
  }
  it('recovers a tilted plane normal within 1°, oriented toward +Z', () => {
    const tilt: [number, number, number] = [0.3, -0.2, 0.9327379053088815]   // unit
    const n = 4000, pos = plane(n, tilt), g = buildGrid(pos, n, 1.5, 1024)
    let worst = 0, flipped = 0
    for (let i = 0; i < n; i += 97) { const v = normalAt(g, pos, i); worst = Math.max(worst, angleDeg(v, tilt)); if (v[2] < 0) flipped++ }
    expect(worst).toBeLessThan(1)
    expect(flipped).toBe(0)
  })
  it('isolated point → +Z, computeNormals reports progress', () => {
    const pos = new Float32Array([5, 5, 5, 50, 50, 50, 50.1, 50, 50])
    const g = buildGrid(pos, 3, 1, 1024)
    expect(normalAt(g, pos, 0)).toEqual([0, 0, 1])
    const seen: number[] = []
    const out = computeNormals(g, pos, 3, undefined, 0, (d) => seen.push(d))
    expect(out.length).toBe(3)
    expect(angleDeg(octDecode(out[0]), [0, 0, 1])).toBeLessThan(0.01)   // +Z quantises to 32768/65535, not exactly 0.5
    expect(seen[seen.length - 1]).toBe(3)
  })
})
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement `cpu/normals.ts`**

```ts
import { K } from '../params'
import { knn, type Grid } from './hash'

// CPU mirror of normals.wgsl.ts. Matrices are number[9] row-major; symmetric input.

const EIG_EPS = 1e-6
const SLICE = 100_000

export function jacobiEigen(m: number[]): { values: [number, number, number]; vectors: number[] } {
  const a = m.slice()
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = a[p * 3 + q]
      if (Math.abs(apq) < 1e-12) continue
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const sg = theta >= 0 ? 1 : -1
      const t = sg / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      a[p * 3 + p] -= t * apq
      a[q * 3 + q] += t * apq
      a[p * 3 + q] = 0; a[q * 3 + p] = 0
      const r = 3 - p - q                                   // the third index
      const arp = a[r * 3 + p], arq = a[r * 3 + q]
      a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p]
      a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q]
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v }
}

export function smallestEigenvector(m: number[]): [number, number, number] | null {
  const { values, vectors } = jacobiEigen(m)
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
  if (values[order[1]] - values[order[0]] < EIG_EPS) return null
  const k = order[0]
  const x = vectors[k], y = vectors[3 + k], z = vectors[6 + k]
  const l = Math.hypot(x, y, z)
  if (!(l > 0) || !Number.isFinite(l)) return null
  return [x / l, y / l, z / l]
}

export function octEncode(n: [number, number, number]): number {
  const l1 = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])
  let px = n[0] / l1, py = n[1] / l1
  if (n[2] < 0) {
    const qx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1), qy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1)
    px = qx; py = qy
  }
  const ux = Math.round((px * 0.5 + 0.5) * 65535), uy = Math.round((py * 0.5 + 0.5) * 65535)
  return (ux | (uy << 16)) >>> 0
}

export function octDecode(w: number): [number, number, number] {
  const fx = ((w & 0xffff) / 65535) * 2 - 1, fy = ((w >>> 16) / 65535) * 2 - 1
  let x = fx, y = fy
  const z = 1 - Math.abs(fx) - Math.abs(fy)
  if (z < 0) { x = (1 - Math.abs(fy)) * (fx >= 0 ? 1 : -1); y = (1 - Math.abs(fx)) * (fy >= 0 ? 1 : -1) }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

export function normalAt(g: Grid, pos: Float32Array, i: number): [number, number, number] {
  const nn = knn(g, pos, i, K)
  if (nn.n < 3) return [0, 0, 1]
  // mean over the point and its neighbours
  let mx = pos[i * 3], my = pos[i * 3 + 1], mz = pos[i * 3 + 2]
  for (let m = 0; m < nn.n; m++) { const j = nn.idx[m]; mx += pos[j * 3]; my += pos[j * 3 + 1]; mz += pos[j * 3 + 2] }
  const cnt = nn.n + 1
  mx /= cnt; my /= cnt; mz /= cnt
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  const acc = (j: number) => {
    const dx = pos[j * 3] - mx, dy = pos[j * 3 + 1] - my, dz = pos[j * 3 + 2] - mz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  acc(i)
  for (let m = 0; m < nn.n; m++) acc(nn.idx[m])
  const v = smallestEigenvector([xx / cnt, xy / cnt, xz / cnt, xy / cnt, yy / cnt, yz / cnt, xz / cnt, yz / cnt, zz / cnt])
  if (!v) return [0, 0, 1]
  return v[2] < 0 ? [-v[0], -v[1], -v[2]] : v
}

// Fills out[start, end) so a caller can slice the work (the worker yields between slices).
export function computeNormals(g: Grid, pos: Float32Array, end: number, out = new Uint32Array(end), start = 0, onSlice?: (done: number) => void): Uint32Array {
  for (let i = start; i < end; i++) {
    out[i] = octEncode(normalAt(g, pos, i))
    if (onSlice && ((i + 1) % SLICE === 0 || i + 1 === end)) onSlice(i + 1)
  }
  return out
}
```

- [ ] **Step 3: Run, expect pass; commit**

`npx vitest run src/viewer/compute/cpu/normals.test.ts` → 8 PASS. If the tilted-plane test exceeds 1°, the bug is in the rotation update (check `a[r*3+p]` / `a[r*3+q]` formulas against the NR "rotate" and that `apq` is read before the diagonal update).

```bash
git add src/viewer/compute/cpu/normals.ts src/viewer/compute/cpu/normals.test.ts
git commit -m "compute: cpu normals (jacobi pca, oct encoding)"
```

---

### Task 3: CPU AO + cooperative runner

**Files:**
- Create: `src/viewer/compute/cpu/ao.ts`, `src/viewer/compute/cpu/run.ts`
- Test: `src/viewer/compute/cpu/ao.test.ts`, `src/viewer/compute/cpu/run.test.ts`

**Interfaces:**
- Produces: `aoAt(grid, pos, i, normal: [number, number, number], eps: number): number` (0..1; `1 − above/total`, 1 when no neighbours); `computeAo(grid, pos, normals: Uint32Array, end, eps, out?: Uint8Array, start = 0, onSlice?): Uint8Array` (`round(ao × 255)`, fills `[start, end)`); `runCpu(input: CpuInput, io: CpuIO): Promise<CpuResult | null>` where `CpuInput { words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }`, `CpuIO { progress(frac: number): void; cancelled(): boolean; yield(): Promise<void> }`, `CpuResult { normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }` (null when cancelled). Progress: hash counts 10 %, normals 60 %, ao 30 %.

- [ ] **Step 1: Failing tests**

`ao.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aoAt, computeAo } from './ao'
import { buildGrid } from './hash'
import { octEncode } from './normals'

function gridPlane(n: number) {      // z = 0 lattice, 1 m pitch, n×n
  const pos = new Float32Array(n * n * 3)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = y * n + x; pos[i * 3] = x + 1; pos[i * 3 + 1] = y + 1; pos[i * 3 + 2] = 5 }
  return pos
}

describe('aoAt', () => {
  it('≈ 1 on a flat plane (no neighbour above the tangent plane)', () => {
    const pos = gridPlane(30), n = 900, g = buildGrid(pos, n, 2.5, 1024)
    expect(aoAt(g, pos, 15 * 30 + 15, [0, 0, 1], 0.05)).toBeCloseTo(1, 6)
  })
  it('lower in an inner corner (floor point next to a wall) than on the open floor', () => {
    // floor z=5 (x 1..30, y 1..30) + wall x=30.5 (y 1..30, z 5..30)
    const floor = gridPlane(30), wallN = 30 * 26, pos = new Float32Array((900 + wallN) * 3)
    pos.set(floor)
    let k = 900
    for (let y = 0; y < 30; y++) for (let z = 0; z < 26; z++) { pos[k * 3] = 30.5; pos[k * 3 + 1] = y + 1; pos[k * 3 + 2] = 5 + z; k++ }
    const n = 900 + wallN, g = buildGrid(pos, n, 2.5, 4096)
    const i = 15 * 30 + 29                                   // floor point at x = 30, next to the wall
    const corner = aoAt(g, pos, i, [0, 0, 1], 0.05), open = aoAt(g, pos, 15 * 30 + 10, [0, 0, 1], 0.05)
    expect(corner).toBeLessThan(0.75)                        // ≈ 0.68: 8 of 25 neighbours are wall points above the plane
    expect(open).toBeCloseTo(1, 6)
    expect(corner).toBeLessThan(open)
  })
  it('1 with no neighbours; computeAo packs bytes', () => {
    const pos = new Float32Array([1, 1, 1, 50, 50, 50]), g = buildGrid(pos, 2, 1, 1024)
    expect(aoAt(g, pos, 0, [0, 0, 1], 0.02)).toBe(1)
    const out = computeAo(g, pos, new Uint32Array([octEncode([0, 0, 1]), octEncode([0, 0, 1])]), 2, 0.02)
    expect(Array.from(out)).toEqual([255, 255])
  })
})
```

`run.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runCpu } from './run'
import { packWords } from '../../format/quant'

function words(n: number): Uint32Array {
  const w = new Uint32Array(n * 2)
  let s = 5; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  for (let i = 0; i < n; i++) { const [a, b] = packWords(Math.floor(r() * 65535), Math.floor(r() * 65535), Math.floor(r() * 2000), 0); w[i * 2] = a; w[i * 2 + 1] = b }
  return w
}

describe('runCpu', () => {
  it('produces normals + ao for every point, reports progress up to 1, times each stage', async () => {
    const n = 5000, progress: number[] = []
    const res = await runCpu({ words: words(n), n, dqScale: [0.01, 0.01, 0.01], radius: 3, tableSize: 1024 },
      { progress: (f) => progress.push(f), cancelled: () => false, yield: () => Promise.resolve() })
    expect(res).not.toBeNull()
    expect(res!.normals.length).toBe(n); expect(res!.ao.length).toBe(n)
    expect(progress[progress.length - 1]).toBe(1)
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true)
    expect(progress.length).toBe(1 + 1 + 1)      // hash + one normals slice + one ao slice at n = 5000
    expect(res!.ms.hash).toBeGreaterThanOrEqual(0); expect(res!.ms.normals).toBeGreaterThan(0); expect(res!.ms.ao).toBeGreaterThanOrEqual(0)
  })
  it('reports one progress step per 100k slice', async () => {
    const n = 250_000, progress: number[] = []
    await runCpu({ words: words(n), n, dqScale: [0.001, 0.001, 0.001], radius: 0.5, tableSize: 32768 },
      { progress: (f) => progress.push(f), cancelled: () => false, yield: () => Promise.resolve() })
    expect(progress.length).toBe(1 + 3 + 3)      // hash, 3 normals slices, 3 ao slices
  })
  it('returns null when cancelled', async () => {
    let calls = 0
    const res = await runCpu({ words: words(300_000), n: 300_000, dqScale: [0.001, 0.001, 0.001], radius: 1, tableSize: 65536 },
      { progress: () => {}, cancelled: () => ++calls > 1, yield: () => Promise.resolve() })
    expect(res).toBeNull()
  })
})
```

Run → FAIL.

- [ ] **Step 2: Implement**

`cpu/ao.ts`:

```ts
import { forEachNeighbour, type Grid } from './hash'
import { octDecode } from './normals'

const SLICE = 100_000

// Fraction of neighbours within radius that lie above the tangent plane (dot(pj − p, n) > eps) → occlusion.
export function aoAt(g: Grid, pos: Float32Array, i: number, n: [number, number, number], eps: number): number {
  let total = 0, above = 0
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  forEachNeighbour(g, pos, i, g.radius * g.radius, (j) => {
    total++
    if ((pos[j * 3] - px) * n[0] + (pos[j * 3 + 1] - py) * n[1] + (pos[j * 3 + 2] - pz) * n[2] > eps) above++
  })
  return total === 0 ? 1 : 1 - above / total
}

// Fills out[start, end) so a caller can slice the work.
export function computeAo(g: Grid, pos: Float32Array, normals: Uint32Array, end: number, eps: number, out = new Uint8Array(end), start = 0, onSlice?: (done: number) => void): Uint8Array {
  for (let i = start; i < end; i++) {
    out[i] = Math.round(aoAt(g, pos, i, octDecode(normals[i]), eps) * 255)
    if (onSlice && ((i + 1) % SLICE === 0 || i + 1 === end)) onSlice(i + 1)
  }
  return out
}
```

`cpu/run.ts`:

```ts
import { EPS_MUL } from '../params'
import { buildGrid, decodePositions } from './hash'
import { computeNormals } from './normals'
import { computeAo } from './ao'

export interface CpuInput { words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }
export interface CpuIO { progress(frac: number): void; cancelled(): boolean; yield(): Promise<void> }
export interface CpuResult { normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }

const SLICE = 100_000

// Same passes as the GPU pipeline, cooperative: yields to the event loop every SLICE points so the worker
// can see a cancel message between slices. Benchmark and oracle only — never a rendering path.
export async function runCpu(input: CpuInput, io: CpuIO): Promise<CpuResult | null> {
  const { n, radius } = input
  let t = performance.now()
  const pos = decodePositions(input.words, n, input.dqScale)
  const grid = buildGrid(pos, n, radius, input.tableSize)
  const hash = performance.now() - t
  io.progress(0.1)
  await io.yield()
  if (io.cancelled()) return null

  t = performance.now()
  const normals = new Uint32Array(n)
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE)
    computeNormals(grid, pos, end, normals, start)
    io.progress(0.1 + 0.6 * (end / n))
    await io.yield()
    if (io.cancelled()) return null
  }
  const normalsMs = performance.now() - t

  t = performance.now()
  const ao = new Uint8Array(n)
  const eps = EPS_MUL * radius
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE)
    computeAo(grid, pos, normals, end, eps, ao, start)
    io.progress(0.7 + 0.3 * (end / n))
    await io.yield()
    if (io.cancelled()) return null
  }
  return { normals, ao, ms: { hash, normals: normalsMs, ao: performance.now() - t } }
}
```

- [ ] **Step 3: Run, expect pass; commit**

`npx vitest run src/viewer/compute/cpu` → all PASS (the 300k cancel test should finish in < 2 s since it cancels after the hash stage).

```bash
git add src/viewer/compute/cpu/ao.ts src/viewer/compute/cpu/ao.test.ts src/viewer/compute/cpu/run.ts src/viewer/compute/cpu/run.test.ts src/viewer/compute/cpu/normals.ts src/viewer/compute/cpu/hash.ts
git commit -m "compute: cpu ao and cooperative runner"
```

---

### Task 4: GPU hash kernels, pipeline skeleton, timing — browser spike vs CPU

**Files:**
- Create: `src/viewer/compute/wgsl/helpers.ts`, `src/viewer/compute/wgsl/hash.ts`, `src/viewer/compute/timing.ts`, `src/viewer/compute/pipeline.ts`, `src/viewer/compute/ComputeRunner.tsx`
- Modify: `src/viewer/render/Scene.tsx` (mount `<ComputeRunner>`, extend `ViewerApi`)

**Interfaces:**
- `wgsl/helpers.ts`: `export const helpers = wgsl(HELPERS_SRC)` — WGSL functions `pcvDecodePos(w: vec2<u32>, dqScale: vec3<f32>) -> vec3<f32>`, `pcvCellKey(c: vec3<i32>, mask: u32) -> u32`, `pcvOctEncode(n: vec3<f32>) -> u32`, `pcvOctDecode(w: u32) -> vec3<f32>`, `pcvSmallestEigenvector(m: array<f32, 9>) -> vec4<f32>` (xyz = unit vector, w = 0 when degenerate).
- `wgsl/hash.ts`: `zeroCells`, `countCells`, `reduceBlocks`, `scanBlockSums`, `scanCells`, `scatterPoints` (`wgslFn` nodes with `[helpers]` includes).
- `timing.ts`: `timedCompute(renderer: WebGPURenderer, node: Node, pass: string): Promise<PassTiming>`.
- `pipeline.ts`: `createComputePipeline(renderer: WebGPURenderer, buffers: PointBuffers, manifest: Manifest): ComputePipeline` with `ComputePipeline { tableSize: number; build(radius: number): Promise<PassTiming[]>; buildHashOnly(radius: number): Promise<PassTiming[]>; readback(): Promise<{ normals: Uint32Array; ao: Uint32Array; cellStart: Uint32Array }>; dispose(): void }`. In this task `build` runs zero + count + scan + scatter only (normals/ao added in Task 5).
- `ViewerApi` gains `build?: (radius: number) => Promise<void>` and `readback?: ComputePipeline['readback']`. `<ComputeRunner>` (child of `<Canvas>`, after `<PostPass>`) creates the pipeline in a layout effect, sets `api.build`/`api.readback`, and writes `store.compute` (`running` → `built` with timings/elapsed/builtRadius, or `error`). DEV: `window.__pcvCompute = { build, readback, cpuGrid }`.

- [ ] **Step 1: `wgsl/helpers.ts`**

```ts
import { wgsl } from 'three/tsl'

// Shared WGSL helpers, included by every kernel (`wgslFn(src, [helpers])`). Mirrors compute/cpu/*.
export const helpers = wgsl(/* wgsl */ `
fn pcvDecodePos(w: vec2<u32>, dqScale: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(f32(w.x & 0xffffu), f32(w.x >> 16u), f32(w.y & 0xffffu)) * dqScale;
}
fn pcvCellKey(c: vec3<i32>, mask: u32) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) & mask;
}
fn pcvOctEncode(n: vec3<f32>) -> u32 {
  let l1 = abs(n.x) + abs(n.y) + abs(n.z);
  var p = n.xy / l1;
  if (n.z < 0.0) {
    p = (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
  }
  let u = vec2<u32>(round((p * 0.5 + 0.5) * 65535.0));
  return u.x | (u.y << 16u);
}
fn pcvOctDecode(w: u32) -> vec3<f32> {
  let f = vec2<f32>(f32(w & 0xffffu), f32(w >> 16u)) / 65535.0 * 2.0 - 1.0;
  var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  if (n.z < 0.0) {
    let t = (vec2<f32>(1.0) - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0));
    n = vec3<f32>(t, n.z);
  }
  return normalize(n);
}
// Cyclic Jacobi on a symmetric 3x3 (row-major array), 8 sweeps. xyz = eigenvector of the smallest eigenvalue,
// w = 0 when the two smallest eigenvalues coincide (within 1e-6) — the caller substitutes +Z.
fn pcvSmallestEigenvector(mIn: array<f32, 9>) -> vec4<f32> {
  var a = mIn;
  var v = array<f32, 9>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  for (var sweep = 0; sweep < 8; sweep++) {
    for (var p = 0; p < 2; p++) {
      for (var q = p + 1; q < 3; q++) {
        let apq = a[p * 3 + q];
        if (abs(apq) < 1e-12) { continue; }
        let theta = (a[q * 3 + q] - a[p * 3 + p]) / (2.0 * apq);
        let sg = select(-1.0, 1.0, theta >= 0.0);
        let t = sg / (abs(theta) + sqrt(theta * theta + 1.0));
        let c = 1.0 / sqrt(t * t + 1.0);
        let s = t * c;
        a[p * 3 + p] = a[p * 3 + p] - t * apq;
        a[q * 3 + q] = a[q * 3 + q] + t * apq;
        a[p * 3 + q] = 0.0; a[q * 3 + p] = 0.0;
        let r = 3 - p - q;
        let arp = a[r * 3 + p]; let arq = a[r * 3 + q];
        a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p];
        a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q];
        for (var k = 0; k < 3; k++) {
          let vkp = v[k * 3 + p]; let vkq = v[k * 3 + q];
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let l0 = a[0]; let l1 = a[4]; let l2 = a[8];
  var k = 0; var lmin = l0; var lmid = min(l1, l2);
  if (l1 < lmin) { k = 1; lmid = min(l0, l2); lmin = l1; }
  if (l2 < lmin) { k = 2; lmid = min(l0, l1); lmin = l2; }
  if (lmid - lmin < 1e-6) { return vec4<f32>(0.0, 0.0, 1.0, 0.0); }
  let e = vec3<f32>(v[k], v[3 + k], v[6 + k]);
  let len = length(e);
  if (!(len > 0.0)) { return vec4<f32>(0.0, 0.0, 1.0, 0.0); }
  return vec4<f32>(e / len, 1.0);
}
`)
```

- [ ] **Step 2: `wgsl/hash.ts`**

```ts
import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Every kernel returns a u32 and the call is .toVar()-ed (three 0.186 drops void wgslFn calls).
// cellStart / cellCursor are array<atomic<u32>> everywhere (storage(...).toAtomic()); non-atomic use goes
// through atomicLoad / atomicStore.

export const zeroCells = wgslFn(/* wgsl */ `
  fn zeroCells(cellStart: ptr<storage, array<atomic<u32>>, read_write>, i: u32, n: u32) -> u32 {
    if (i < n) { atomicStore(&cellStart[i], 0u); }
    return 0u;
  }
`)

export const countCells = wgslFn(/* wgsl */ `
  fn countCells(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
                i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let key = pcvCellKey(vec3<i32>(floor(p / radius)), mask);
    atomicAdd(&cellStart[key], 1u);
    return key;
  }
`, [helpers])

// Reduce-then-scan over T cells in blocks of 256, thread-per-block, serial inside the block (no workgroup memory).
export const reduceBlocks = wgslFn(/* wgsl */ `
  fn reduceBlocks(cellStart: ptr<storage, array<atomic<u32>>, read_write>, blockSums: ptr<storage, array<u32>, read_write>,
                  b: u32, blocks: u32) -> u32 {
    if (b >= blocks) { return 0u; }
    var sum = 0u;
    for (var j = 0u; j < 256u; j++) { sum = sum + atomicLoad(&cellStart[b * 256u + j]); }
    blockSums[b] = sum;
    return sum;
  }
`)

export const scanBlockSums = wgslFn(/* wgsl */ `
  fn scanBlockSums(blockSums: ptr<storage, array<u32>, read_write>, i: u32, blocks: u32) -> u32 {
    if (i != 0u) { return 0u; }
    var acc = 0u;
    for (var b = 0u; b < blocks; b++) { let v = blockSums[b]; blockSums[b] = acc; acc = acc + v; }
    return acc;
  }
`)

export const scanCells = wgslFn(/* wgsl */ `
  fn scanCells(cellStart: ptr<storage, array<atomic<u32>>, read_write>, cellCursor: ptr<storage, array<atomic<u32>>, read_write>,
               blockSums: ptr<storage, array<u32>, read_write>, b: u32, blocks: u32, tableSize: u32) -> u32 {
    if (b >= blocks) { return 0u; }
    var acc = blockSums[b];
    for (var j = 0u; j < 256u; j++) {
      let c = b * 256u + j;
      let v = atomicLoad(&cellStart[c]);
      atomicStore(&cellStart[c], acc);
      atomicStore(&cellCursor[c], acc);
      acc = acc + v;
    }
    if (b == blocks - 1u) { atomicStore(&cellStart[tableSize], acc); }
    return acc;
  }
`)

export const scatterPoints = wgslFn(/* wgsl */ `
  fn scatterPoints(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellCursor: ptr<storage, array<atomic<u32>>, read_write>,
                   sorted: ptr<storage, array<u32>, read_write>, i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let key = pcvCellKey(vec3<i32>(floor(p / radius)), mask);
    let slot = atomicAdd(&cellCursor[key], 1u);
    sorted[slot] = i;
    return slot;
  }
`, [helpers])
```

- [ ] **Step 3: `timing.ts`**

```ts
import * as THREE from 'three/webgpu'
import type { Node } from 'three/webgpu'
import type { PassTiming } from '../state/store'

// submit = CPU encode + submit (computeAsync does not await GPU completion); gpu = timestamp-query delta
// (Metal quantises to ~0.066 ms). Only the resolve result is used — never renderer.info (the HUD resets it).
export async function timedCompute(renderer: THREE.WebGPURenderer, node: Node, pass: string): Promise<PassTiming> {
  const t0 = performance.now()
  await renderer.computeAsync(node)
  const submitMs = performance.now() - t0
  const gpuMs = renderer.hasFeature('timestamp-query') ? await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE) : null
  return { pass, submitMs, gpuMs: typeof gpuMs === 'number' ? gpuMs : null }
}
```

- [ ] **Step 4: `pipeline.ts` (hash passes only in this task)**

```ts
import * as THREE from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, uniform, vec3 } from 'three/tsl'
import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import type { PassTiming } from '../state/store'
import { SCAN_BLOCK, tableSizeFor } from './params'
import { timedCompute } from './timing'
import { zeroCells, countCells, reduceBlocks, scanBlockSums, scanCells, scatterPoints } from './wgsl/hash'

export interface ComputePipeline {
  tableSize: number
  build(radius: number): Promise<PassTiming[]>
  readback(): Promise<{ normals: Uint32Array; ao: Uint32Array; cellStart: Uint32Array }>
  dispose(): void
}

type U = Node<'uint'>
const call = (fn: (args: object) => unknown, args: object) => (fn(args) as U).toVar()   // wgslFn calls are typed as bare Node

export function createComputePipeline(renderer: THREE.WebGPURenderer, buffers: PointBuffers, manifest: Manifest): ComputePipeline {
  const N = buffers.count
  const T = tableSizeFor(N)
  const blocks = T / SCAN_BLOCK
  const cellStartAttr = new THREE.StorageBufferAttribute(new Uint32Array(T + 1), 1)
  const cellCursorAttr = new THREE.StorageBufferAttribute(new Uint32Array(T), 1)
  const blockSumsAttr = new THREE.StorageBufferAttribute(new Uint32Array(blocks), 1)
  const sortedAttr = new THREE.StorageBufferAttribute(new Uint32Array(N), 1)
  const cellStart = storage(cellStartAttr, 'uint', T + 1).toAtomic() as StorageBufferNode<'uint'>
  const cellCursor = storage(cellCursorAttr, 'uint', T).toAtomic() as StorageBufferNode<'uint'>
  const blockSums = storage(blockSumsAttr, 'uint', blocks)
  const sorted = storage(sortedAttr, 'uint', N)

  const dqScale = vec3(...dequantScale(manifest.bounds))
  const radius = uniform(1)
  const common = { qpos: buffers.qposNode, count: uint(N), dqScale, radius, mask: uint(T - 1) }

  const kZero = Fn(() => { call(zeroCells, { cellStart, i: instanceIndex, n: uint(T + 1) }) })().compute(T + 1, [64])
  const kCount = Fn(() => { call(countCells, { ...common, cellStart, i: instanceIndex }) })().compute(N, [64])
  const kReduce = Fn(() => { call(reduceBlocks, { cellStart, blockSums, b: instanceIndex, blocks: uint(blocks) }) })().compute(blocks, [64])
  const kScanSums = Fn(() => { call(scanBlockSums, { blockSums, i: instanceIndex, blocks: uint(blocks) }) })().compute(1, [1])
  const kScanCells = Fn(() => { call(scanCells, { cellStart, cellCursor, blockSums, b: instanceIndex, blocks: uint(blocks), tableSize: uint(T) }) })().compute(blocks, [64])
  const kScatter = Fn(() => { call(scatterPoints, { ...common, cellCursor, sorted, i: instanceIndex }) })().compute(N, [64])

  async function hashPasses(): Promise<PassTiming[]> {
    const out: PassTiming[] = []
    await renderer.computeAsync(kZero)                          // not timed: bookkeeping
    out.push(await timedCompute(renderer, kCount, 'count'))
    const r = await timedCompute(renderer, kReduce, 'scan')
    const s = await timedCompute(renderer, kScanSums, 'scan')
    const c = await timedCompute(renderer, kScanCells, 'scan')
    out.push({ pass: 'scan', submitMs: r.submitMs + s.submitMs + c.submitMs, gpuMs: r.gpuMs === null || s.gpuMs === null || c.gpuMs === null ? null : r.gpuMs + s.gpuMs + c.gpuMs })
    out.push(await timedCompute(renderer, kScatter, 'scatter'))
    return out
  }

  return {
    tableSize: T,
    async build(r) {
      radius.value = r
      return hashPasses()                                         // Task 5 appends normals + ao
    },
    async readback() {
      const [normals, ao, cs] = await Promise.all([
        renderer.getArrayBufferAsync(buffers.normals), renderer.getArrayBufferAsync(buffers.ao), renderer.getArrayBufferAsync(cellStartAttr),
      ])
      return { normals: new Uint32Array(normals), ao: new Uint32Array(ao), cellStart: new Uint32Array(cs) }
    },
    dispose() { for (const n of [cellStart, cellCursor, blockSums, sorted]) n.dispose() },
  }
}
```

Typing notes: `wgslFn` calls are typed as bare `Node` in `@types/three` (Phase 0 note) — the `call` helper casts once. If `Fn(() => { call(...) })` complains about a `void` body, return the `toVar()` result: `Fn(() => call(...))`. `.toAtomic()` returns `this`; the cast keeps the `'uint'` generic. `getArrayBufferAsync(attribute)` returns an `ArrayBuffer` and throws if the attribute was never bound by a pipeline — `normals`/`ao` are bound by the vertex stage every frame, `cellStart` after the first build.

- [ ] **Step 5: `ComputeRunner.tsx` + `Scene.tsx` wiring**

```tsx
import { useLayoutEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import type { ViewerApi } from '../render/Scene'
import { useViewerStore } from '../state/store'
import { createComputePipeline, type ComputePipeline } from './pipeline'

// Owns the compute pipeline (needs the renderer, so it lives inside <Canvas>) and exposes build/readback on the api.
export function ComputeRunner({ buffers, manifest, api }: { buffers: PointBuffers; manifest: Manifest; api: ViewerApi }) {
  const gl = useThree((s) => s.gl)
  const store = useViewerStore()
  const ref = useRef<ComputePipeline | null>(null)

  useLayoutEffect(() => {
    const p = createComputePipeline(gl as unknown as THREE.WebGPURenderer, buffers, manifest)
    ref.current = p
    api.build = async (radius) => {
      const c = store.get().compute
      store.set({ compute: { ...c, status: 'running', error: undefined } })
      const t0 = performance.now()
      try {
        const timings = await p.build(radius)
        store.set({ compute: { ...store.get().compute, status: 'built', timings, elapsedMs: performance.now() - t0, builtRadius: radius } })
      } catch (err) {
        store.set({ compute: { ...store.get().compute, status: 'error', error: String(err) } })
      }
    }
    api.readback = () => p.readback()
    if (import.meta.env.DEV) (window as unknown as { __pcvCompute?: unknown }).__pcvCompute = { build: api.build, readback: api.readback, tableSize: p.tableSize }
    return () => { api.build = undefined; api.readback = undefined; ref.current = null; p.dispose() }
  }, [gl, buffers, manifest, api, store])

  return null
}
```

`Scene.tsx`: extend `ViewerApi`:

```ts
export interface ViewerApi {
  fit: () => void
  sendCamera?: (pos: [number, number, number]) => void
  build?: (radius: number) => Promise<void>
  readback?: () => Promise<{ normals: Uint32Array; ao: Uint32Array; cellStart: Uint32Array }>
}
```

and mount `<ComputeRunner buffers={buffers} manifest={manifest} api={api} />` after `<PostPass />` (import from `'../compute/ComputeRunner'`).

- [ ] **Step 6: Gates + browser spike (hash correctness at 2M vs CPU)**

`npx tsc --noEmit && npx vitest run` → green. Dev server up. Playwright: navigate `http://localhost:5173/`, wait for `loaded 2,000,000/2,000,000`, then `browser_evaluate`:

```js
async () => {
  const c = window.__pcvCompute
  const t0 = performance.now()
  await c.build(3 * Math.sqrt(1e6 / 2e6))        // 3 × spacing on the demo tile (1 km²)
  const ms = performance.now() - t0
  const rb = await c.readback()
  const cs = rb.cellStart, T = c.tableSize
  let nonMono = 0; for (let i = 1; i <= T; i++) if (cs[i] < cs[i - 1]) nonMono++
  let occupied = 0; for (let i = 0; i < T; i++) if (cs[i + 1] > cs[i]) occupied++
  return { ms, T, last: cs[T], nonMono, occupied, occupancy: occupied / T }
}
```

Expected: `last === 2000000`, `nonMono === 0`, `occupancy` recorded (report it), no console errors. Then compare against the CPU reference for the exact same input — `browser_evaluate` cannot import modules, so add a DEV-only helper to `ComputeRunner`: `window.__pcvCompute.cpuCellStart = (radius) => { const pos = decodePositions(buffers.qpos.array, N, dequantScale(manifest.bounds)); return buildGrid(pos, N, radius, T).cellStart }` (import `decodePositions`, `buildGrid` from `./cpu/hash`, `dequantScale` from `../format/quant`). Then:

```js
async () => {
  const c = window.__pcvCompute, r = 3 * Math.sqrt(1e6 / 2e6)
  const cpu = c.cpuCellStart(r), gpu = (await c.readback()).cellStart
  let diff = 0; for (let i = 0; i < cpu.length; i++) if (cpu[i] !== gpu[i]) diff++
  return { diff, len: cpu.length }
}
```

Expected `diff === 0` (cellStart is order-independent). If it differs: check `pcvCellKey` vs `cellKey` (u32 wrap: WGSL `u32(c.x) * 73856093u` wraps mod 2³² like `Math.imul`), and `floor(p / radius)` uses the same `dqScale` (f32 on GPU vs f64 on CPU — a point exactly on a cell boundary can flip; report the count if small and non-zero, and confirm the flipped points sit within 1e-4 of a boundary). Console must be clean (a WGSL compile error on the `ptr<storage, array<atomic<u32>>, read_write>` params shows up here — fallback per rulings: a second plain `storage()` node for the non-atomic kernels).

Also record the hash timings from `store.get().compute.timings` via `browser_evaluate` (read `#hud`-style: `JSON.stringify(...)` needs the store — expose `window.__pcvCompute.timings = () => store.get().compute.timings` in DEV).

- [ ] **Step 7: Commit**

```bash
git add src/viewer/compute src/viewer/render/Scene.tsx
git commit -m "compute: gpu spatial hash (zero/count/scan/scatter), timing, pipeline skeleton, ComputeRunner"
```

---

### Task 5: Normals + AO kernels, shading modes, Compute panel group

**Files:**
- Create: `src/viewer/compute/wgsl/normals.ts`, `src/viewer/compute/wgsl/ao.ts`
- Modify: `src/viewer/compute/pipeline.ts`, `src/viewer/render/pointMaterial.ts`, `src/viewer/render/ChunkSprites.tsx`, `src/viewer/ui/Panel.tsx`, `src/viewer/ui/Panel.module.css`, `src/viewer/PointCloudViewer.tsx`

**Interfaces:**
- `wgsl/normals.ts`: `normalsKernel` (`wgslFn`, includes helpers); `wgsl/ao.ts`: `aoKernel`.
- `pipeline.build(radius)` now returns 5 rows: count, scan, scatter, normals, ao.
- `PointMaterialHandle.setShading(mode: Shading): void`; `createPointMaterial(buffers, manifest, init: Pick<ViewerState, 'pointSize' | 'colorMode' | 'colormap' | 'shading'>)`.
- `Panel` takes `api: ViewerApi`; `PointCloudViewer` passes it.

- [ ] **Step 1: `wgsl/normals.ts`**

```ts
import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Thread per point: 27-cell kNN (K = 16, register insertion sort), PCA over the point + neighbours,
// smallest eigenvector via Jacobi, +Z orientation, oct-encode. Mirrors compute/cpu/normals.ts.
export const normalsKernel = wgslFn(/* wgsl */ `
  fn normalsKernel(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
                   sorted: ptr<storage, array<u32>, read_write>, normals: ptr<storage, array<u32>, read_write>,
                   i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let r2 = radius * radius;
    let c0 = vec3<i32>(floor(p / radius));
    var nd: array<f32, 16>;
    var ni: array<u32, 16>;
    var n = 0u;
    for (var dz = -1; dz <= 1; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let c = c0 + vec3<i32>(dx, dy, dz);
          if (any(c < vec3<i32>(0))) { continue; }
          let key = pcvCellKey(c, mask);
          let start = atomicLoad(&cellStart[key]);
          let end = atomicLoad(&cellStart[key + 1u]);
          for (var s = start; s < end; s++) {
            let j = sorted[s];
            if (j == i) { continue; }
            let d = pcvDecodePos(qpos[j], dqScale) - p;
            let d2 = dot(d, d);
            if (d2 > r2) { continue; }
            if (n < 16u) {
              var m = n;
              while (m > 0u && nd[m - 1u] > d2) { nd[m] = nd[m - 1u]; ni[m] = ni[m - 1u]; m = m - 1u; }
              nd[m] = d2; ni[m] = j; n = n + 1u;
            } else if (d2 < nd[15]) {
              var m = 15u;
              while (m > 0u && nd[m - 1u] > d2) { nd[m] = nd[m - 1u]; ni[m] = ni[m - 1u]; m = m - 1u; }
              nd[m] = d2; ni[m] = j;
            }
          }
        }
      }
    }
    var out = pcvOctEncode(vec3<f32>(0.0, 0.0, 1.0));
    if (n >= 3u) {
      var mean = p;
      for (var m = 0u; m < n; m++) { mean = mean + pcvDecodePos(qpos[ni[m]], dqScale); }
      let cnt = f32(n + 1u);
      mean = mean / cnt;
      var xx = 0.0; var xy = 0.0; var xz = 0.0; var yy = 0.0; var yz = 0.0; var zz = 0.0;
      var d = p - mean;
      xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
      for (var m = 0u; m < n; m++) {
        d = pcvDecodePos(qpos[ni[m]], dqScale) - mean;
        xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
      }
      let e = pcvSmallestEigenvector(array<f32, 9>(xx / cnt, xy / cnt, xz / cnt, xy / cnt, yy / cnt, yz / cnt, xz / cnt, yz / cnt, zz / cnt));
      if (e.w > 0.0) {
        var nrm = e.xyz;
        if (nrm.z < 0.0) { nrm = -nrm; }
        out = pcvOctEncode(nrm);
      }
    }
    normals[i] = out;
    return out;
  }
`, [helpers])
```

- [ ] **Step 2: `wgsl/ao.ts`**

```ts
import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Thread per word (4 points): AO = 1 − (neighbours above the tangent plane) / (neighbours within radius);
// whole-word store. Mirrors compute/cpu/ao.ts.
export const aoKernel = wgslFn(/* wgsl */ `
  fn aoKernel(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
              sorted: ptr<storage, array<u32>, read_write>, normals: ptr<storage, array<u32>, read_write>,
              ao: ptr<storage, array<u32>, read_write>, w: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32, eps: f32) -> u32 {
    if (w * 4u >= count) { return 0u; }        // split dispatches over-provision threads; never store past the last word
    var out = 0u;
    let r2 = radius * radius;
    for (var k = 0u; k < 4u; k++) {
      let i = w * 4u + k;
      if (i >= count) { break; }
      let p = pcvDecodePos(qpos[i], dqScale);
      let nrm = pcvOctDecode(normals[i]);
      let c0 = vec3<i32>(floor(p / radius));
      var total = 0u; var above = 0u;
      for (var dz = -1; dz <= 1; dz++) {
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            let c = c0 + vec3<i32>(dx, dy, dz);
            if (any(c < vec3<i32>(0))) { continue; }
            let key = pcvCellKey(c, mask);
            let start = atomicLoad(&cellStart[key]);
            let end = atomicLoad(&cellStart[key + 1u]);
            for (var s = start; s < end; s++) {
              let j = sorted[s];
              if (j == i) { continue; }
              let d = pcvDecodePos(qpos[j], dqScale) - p;
              if (dot(d, d) > r2) { continue; }
              total = total + 1u;
              if (dot(d, nrm) > eps) { above = above + 1u; }
            }
          }
        }
      }
      let a = select(1.0, 1.0 - f32(above) / f32(total), total > 0u);
      out = out | (u32(round(a * 255.0)) << (k * 8u));
    }
    ao[w] = out;
    return out;
  }
`, [helpers])
```

- [ ] **Step 3: pipeline — add the two passes**

In `pipeline.ts` import `normalsKernel`, `aoKernel`, `EPS_MUL`; after `kScatter`:

```ts
  const words = Math.ceil(N / 4)
  const eps = uniform(0)
  const kNormals = Fn(() => { call(normalsKernel, { ...common, cellStart, sorted, normals: buffers.normalsNode, i: instanceIndex }) })().compute(N, [64])
  const kAo = Fn(() => { call(aoKernel, { ...common, cellStart, sorted, normals: buffers.normalsNode, ao: buffers.aoNode, w: instanceIndex, eps }) })().compute(words, [64])
```

and `build`:

```ts
    async build(r) {
      radius.value = r
      eps.value = EPS_MUL * r
      const out = await hashPasses()
      out.push(await timedCompute(renderer, kNormals, 'normals'))
      out.push(await timedCompute(renderer, kAo, 'ao'))
      return out
    },
```

- [ ] **Step 4: Material shading**

`pointMaterial.ts`: import `Shading`, `normalize`, `abs`, `dot`, `max`, `transformNormalToView` (`three/tsl`), `FLAG_*` unchanged. Add `const SHADING: Record<Shading, number> = { flat: 0, lit: 1, litAo: 2 }` and `const shading = uniform(SHADING[init.shading])`. After `fbyte`, decode normal and AO in the vertex stage:

```ts
  // Oct-decoded normal and AO byte (compute outputs), vertex-stage reads like qpos/flags.
  const nw = buffers.normalsNode.element(gi)
  const fx = float(nw.bitAnd(uint(0xffff))).div(65535).mul(2).sub(1)
  const fy = float(nw.shiftRight(uint(16))).div(65535).mul(2).sub(1)
  const nz = float(1).sub(abs(fx)).sub(abs(fy))
  const fold = nz.lessThan(0)
  const ox = select(fold, float(1).sub(abs(fy)).mul(select(fx.greaterThanEqual(0), 1, -1)), fx)
  const oy = select(fold, float(1).sub(abs(fx)).mul(select(fy.greaterThanEqual(0), 1, -1)), fy)
  const normalObj = normalize(vec3(ox, oy, nz))
  const nView = normalize(transformNormalToView(normalObj))
  const viewDir = normalize(positionView.negate())
  const lambert = max(abs(dot(nView, viewDir)), 0.15)          // headlight; abs = camera-facing flip
  const aoWord = buffers.aoNode.element(gi.shiftRight(uint(2)))
  const aoByte = float(aoWord.shiftRight(gi.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))).div(255)
  const light = select(shading.equal(0), float(1), select(shading.equal(1), lambert, lambert.mul(aoByte)))
```

and `material.colorNode = lutNode.mul(vertexStage(light))`. Add `setShading: (m) => { shading.value = SHADING[m] }` to the handle and `setShading(mode: Shading): void` to the interface; `init` type gains `'shading'`. `useLoader` already passes `store.get()`.

If `transformNormalToView` is not exported by `three/tsl` in 0.186, use `normalView`-style math directly: `modelViewMatrix` rotation via `mat3(modelViewMatrix).mul(normalObj)` (`modelViewMatrix` from `three/tsl`; the sprite has an identity model matrix, so this is the camera's view rotation).

`ChunkSprites.tsx`: subscribe like the others:

```ts
  const shading = useStore((s) => s.shading)
  useEffect(() => { handle.setShading(shading) }, [handle, shading])
```

- [ ] **Step 5: Panel "Compute" group**

`Panel.module.css` append:

```css
.button { grid-column: 1 / -1; padding: 4px 8px; background: var(--pcv-surface); color: var(--pcv-text); border: 1px solid var(--pcv-border); border-radius: 4px; font: inherit; cursor: pointer; }
.button:disabled { opacity: 0.5; cursor: default; }
.table { display: grid; grid-template-columns: 1fr auto auto; gap: 2px 8px; color: var(--pcv-text-2); font: 11px/1.4 var(--pcv-mono); }
.table span:nth-child(3n+2), .table span:nth-child(3n+3) { text-align: right; }
```

`Panel.tsx`: signature `export function Panel({ api }: { api: ViewerApi })` (import `type ViewerApi` from `'../render/Scene'`, `spacingOf` from `'../compute/params'`, `type Shading`). Selectors: `const status = useStore((s) => s.status)`, `compute`, `shading`. Derived: `const spacing = manifest ? spacingOf(manifest.bounds, manifest.pointCount) : 0`, `const radius = compute.radiusMul * spacing`, `const canBuild = status === 'ready' && compute.status !== 'running' && (compute.status !== 'built' || compute.builtRadius !== radius) && !!api.build`. Insert after the Lighting group:

```tsx
      <div className={styles.group}>
        <div className={styles.groupTitle}>Compute</div>
        <label className={styles.row}><span>Radius</span><span>{compute.radiusMul.toFixed(1)}× = {radius.toFixed(2)} m</span>
          <input type="range" min={1} max={6} step={0.5} value={compute.radiusMul} disabled={compute.status === 'running'}
            onChange={(e) => store.set({ compute: { ...store.get().compute, radiusMul: Number(e.target.value) } })} /></label>
        <button className={styles.button} disabled={!canBuild} onClick={() => api.build?.(radius)}>
          {compute.status === 'running' ? 'Building…' : compute.status === 'built' && compute.builtRadius === radius ? 'Built' : 'Build normals + AO'}
        </button>
        {compute.status === 'error' && <div className={styles.muted}>{compute.error}</div>}
        {compute.timings.length > 0 && (
          <div className={styles.table}>
            <span>pass</span><span>submit</span><span>gpu</span>
            {compute.timings.map((t) => <Fragment key={t.pass}><span>{t.pass}</span><span>{t.submitMs.toFixed(2)}</span><span>{t.gpuMs === null ? 'n/a' : t.gpuMs.toFixed(2)}</span></Fragment>)}
            <span>total</span><span>{compute.timings.reduce((a, t) => a + t.submitMs, 0).toFixed(2)}</span>
            <span>{compute.timings.some((t) => t.gpuMs === null) ? 'n/a' : compute.timings.reduce((a, t) => a + (t.gpuMs ?? 0), 0).toFixed(2)}</span>
            <span className={styles.muted}>wall</span><span /><span>{compute.elapsedMs?.toFixed(0)} ms</span>
          </div>
        )}
        <label className={styles.row}><span>Shading</span>
          <select value={shading} onChange={(e) => store.set({ shading: e.target.value as Shading })}>
            <option value="flat">Flat</option>
            <option value="lit" disabled={compute.status !== 'built'}>Normal-lit</option>
            <option value="litAo" disabled={compute.status !== 'built'}>Lit + AO</option>
          </select></label>
      </div>
```

(import `Fragment` from react.) The build always runs over all N: add `<div className={styles.muted}>All {total.toLocaleString()} points, independent of budget.</div>` under the title.

`PointCloudViewer.tsx`: `<Panel api={api} />`.

- [ ] **Step 6: Gates + browser (2M)**

`npx tsc --noEmit && npx vitest run && npm run build` → green. Playwright on the demo: wait for load, click "Build normals + AO" (`browser_snapshot` → button ref), `browser_wait_for` text `Built`. Read timings via `browser_evaluate` (`window.__pcvCompute.timings()`): five rows, `gpuMs` nonzero each, record total GPU ms and wall ms (target < 200 ms; report actual). Console clean. Then select Shading → Normal-lit, wait 500 ms, screenshot `.playwright-mcp/shading-lit.png`; Lit + AO → `.playwright-mcp/shading-litao.png`; Flat → `.playwright-mcp/shading-flat.png`. Visual: lit shows roof/wall facets and no 16×16 grid seams; AO darkens under trees / at wall bases. Readback sanity via `browser_evaluate`: `const { normals, ao } = await window.__pcvCompute.readback(); let z = 0; for (const w of normals) if (w === (32768 | (32768 << 16))) z++; let aoMean = 0; for (const w of ao) for (let k = 0; k < 4; k++) aoMean += (w >>> (k * 8)) & 0xff; return { degeneratePlusZ: z, aoMean: aoMean / 255 / normals.length }` — record both (degenerate should be a small fraction; aoMean typically 0.6–0.9).

If the normals kernel fails to compile: `while` inside nested `for` with `continue` is legal WGSL; `array<f32, 16>` locals are fine; check `pcvSmallestEigenvector` array param passing (WGSL passes arrays by value — allowed). If the GPU hangs > 10 s at 2M, the candidate loop is too long (hash collisions) — record `occupancy` from Task 4 and try `K = 12` only if register spilling is evidenced by a compile warning, otherwise report.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/compute src/viewer/render/pointMaterial.ts src/viewer/render/ChunkSprites.tsx src/viewer/ui/Panel.tsx src/viewer/ui/Panel.module.css src/viewer/PointCloudViewer.tsx
git commit -m "compute: normals + ao kernels, shading modes, compute panel group"
```

---

### Task 6: CPU benchmark in the worker, Verify

**Files:**
- Modify: `src/viewer/loader/fetchChunks.ts` (message types), `src/viewer/loader/loader.worker.ts`, `src/viewer/loader/useLoader.ts`, `src/viewer/render/Scene.tsx` (`ViewerApi`), `src/viewer/ui/Panel.tsx`
- Create: `src/viewer/compute/verify.ts`
- Test: `src/viewer/compute/verify.test.ts`

**Interfaces:**
- `LoaderIn` gains `{ type: 'cpuBench'; words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }` and `{ type: 'cancelBench' }`; `LoaderOut` gains `{ type: 'benchProgress'; frac: number }`, `{ type: 'benchDone'; normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }`, `{ type: 'benchCancelled' }`.
- `ViewerApi` gains `cpuBench?: (radius: number) => Promise<{ normals: Uint32Array; ao: Uint8Array; n: number } | null>` (null = cancelled) and `cancelBench?: () => void` — set by `useLoader`, which also writes `store.bench` (`running`/progress/`done`/`cancelled`, `cpuMs`, `n`).
- `verify.ts`: `compareResults(gpuNormals: Uint32Array, gpuAo: Uint32Array /* packed */, cpuNormals: Uint32Array, cpuAo: Uint8Array, n: number): VerifyResult`.

- [ ] **Step 1: Failing test `verify.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { compareResults } from './verify'
import { octEncode } from './cpu/normals'

const PZ = octEncode([0, 0, 1])
const pack = (bytes: number[]) => { const out = new Uint32Array(Math.ceil(bytes.length / 4)); bytes.forEach((b, i) => { out[i >> 2] |= b << ((i & 3) * 8) }); return out }

describe('compareResults', () => {
  it('identical inputs → 0°, 0 MAE', () => {
    const n = 5, nrm = new Uint32Array(n).fill(octEncode([0.6, 0, 0.8])), ao = [255, 128, 0, 64, 200]
    const r = compareResults(nrm, pack(ao), nrm, new Uint8Array(ao), n)
    expect(r.n).toBe(n); expect(r.aoMae).toBe(0); expect(r.nonFinite).toBe(0); expect(r.degenerate).toBe(0)
    expect(r.medianDeg).toBeLessThan(0.01); expect(r.maxDeg).toBeLessThan(0.01)   // acos(|a·a|) on f32-normalised vectors is not exactly 0
  })
  it('median / max angle, sign-insensitive; AO MAE in [0,1]; counts +Z degenerates', () => {
    const a = [octEncode([1, 0, 0]), octEncode([0, 1, 0]), PZ, octEncode([0, 0, 1])]
    const b = [octEncode([-1, 0, 0]), octEncode([Math.SQRT1_2, Math.SQRT1_2, 0]), PZ, octEncode([0, 0, 1])]
    const r = compareResults(new Uint32Array(a), pack([255, 255, 255, 255]), new Uint32Array(b), new Uint8Array([255, 0, 255, 255]), 4)
    expect(r.maxDeg).toBeCloseTo(45, 1)          // flipped vector counts as 0°; oct 16-bit quantisation ≈ 0.003°
    expect(r.medianDeg).toBeLessThan(0.01)       // sorted angles 0, 0, 0, 45 → median of middle two = 0
    expect(r.aoMae).toBeCloseTo(0.25, 6)
    expect(r.degenerate).toBe(2)
  })
})
```

Run → FAIL.

- [ ] **Step 2: `verify.ts`**

```ts
import type { VerifyResult } from '../state/store'
import { octDecode, octEncode } from './cpu/normals'

const PLUS_Z = octEncode([0, 0, 1])

// Angular difference is sign-insensitive (the camera-facing flip happens at render time).
export function compareResults(gpuNormals: Uint32Array, gpuAo: Uint32Array, cpuNormals: Uint32Array, cpuAo: Uint8Array, n: number): VerifyResult {
  const angles = new Float32Array(n)
  let nonFinite = 0, degenerate = 0, aoErr = 0
  for (let i = 0; i < n; i++) {
    const a = octDecode(gpuNormals[i]), b = octDecode(cpuNormals[i])
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
    if (!Number.isFinite(d)) { nonFinite++; angles[i] = 180; continue }
    angles[i] = Math.acos(Math.min(1, d)) * 180 / Math.PI
    if (gpuNormals[i] === PLUS_Z) degenerate++
    const g = (gpuAo[i >> 2] >>> ((i & 3) * 8)) & 0xff
    aoErr += Math.abs(g - cpuAo[i]) / 255
  }
  const sorted = Float32Array.from(angles).sort()
  const medianDeg = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  return { n, medianDeg, maxDeg: n ? sorted[n - 1] : 0, aoMae: n ? aoErr / n : 0, nonFinite, degenerate }
}
```

- [ ] **Step 3: Worker + messages**

`fetchChunks.ts` — extend the unions:

```ts
export type LoaderIn =
  | { type: 'start'; binUrl: string; chunks: ChunkRef[]; pos?: [number, number, number] }
  | { type: 'camera'; pos: [number, number, number] }
  | { type: 'dispose' }
  | { type: 'cpuBench'; words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }
  | { type: 'cancelBench' }
export type LoaderOut =
  | { type: 'chunk'; index: number; words: Uint32Array }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'benchProgress'; frac: number }
  | { type: 'benchDone'; normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }
  | { type: 'benchCancelled' }
```

`loader.worker.ts` — add `import { runCpu } from '../compute/cpu/run'`, a module-level `let benchCancel = false`, and before the `start` handling:

```ts
  if (msg.type === 'cancelBench') { benchCancel = true; return }
  if (msg.type === 'cpuBench') {
    benchCancel = false
    runCpu(msg, {
      progress: (frac) => ctx.postMessage({ type: 'benchProgress', frac }),
      cancelled: () => benchCancel,
      yield: () => new Promise((r) => setTimeout(r, 0)),   // lets the cancel message land between slices
    }).then((res) => {
      if (!res) { ctx.postMessage({ type: 'benchCancelled' }); return }
      ctx.postMessage({ type: 'benchDone', normals: res.normals, ao: res.ao, ms: res.ms }, [res.normals.buffer, res.ao.buffer])
    })
    return
  }
```

(`msg` narrows to the `cpuBench` variant, which is structurally a `CpuInput`.)

- [ ] **Step 4: `useLoader` — `api.cpuBench` / `api.cancelBench`**

In the worker effect, keep a `let benchResolve: ((r: { normals: Uint32Array; ao: Uint8Array; n: number } | null) => void) | null = null` and `let benchN = 0`. Extend `worker.onmessage`:

```ts
      } else if (msg.type === 'benchProgress') {
        store.set({ bench: { ...store.get().bench, progress: msg.frac } })
      } else if (msg.type === 'benchDone') {
        store.set({ bench: { ...store.get().bench, status: 'done', progress: 1, cpuMs: msg.ms } })
        benchResolve?.({ normals: msg.normals, ao: msg.ao, n: benchN }); benchResolve = null
      } else if (msg.type === 'benchCancelled') {
        store.set({ bench: { ...store.get().bench, status: 'cancelled' } })
        benchResolve?.(null); benchResolve = null
      } else if (msg.type === 'chunk') { … existing … } else if (msg.type === 'done') { … } else { … error … }
```

(reorder so the `error` branch stays the final `else`). After `api.sendCamera = …`:

```ts
    api.cpuBench = (radius) => {
      if (benchResolve) return Promise.resolve(null)
      const total = manifest.pointCount
      benchN = Math.min(total, BENCH_CAP)
      const words = benchWords(buffers.qpos.array as Uint32Array, manifest.chunks, benchN)
      benchN = words.length / WORDS_PER_POINT
      store.set({ bench: { status: 'running', progress: 0, n: benchN, cpuMs: null, verify: null } })
      const m: LoaderIn = { type: 'cpuBench', words: words === buffers.qpos.array ? words.slice() : words, n: benchN, dqScale: dequantScale(manifest.bounds), radius, tableSize: tableSizeFor(benchN) }
      worker.postMessage(m, [m.words.buffer])
      return new Promise((resolve) => { benchResolve = resolve })
    }
    api.cancelBench = () => { const m: LoaderIn = { type: 'cancelBench' }; worker.postMessage(m) }
```

(imports: `BENCH_CAP`, `benchWords`, `tableSizeFor` from `'../compute/params'`, `dequantScale`, `WORDS_PER_POINT` from `'../format/quant'`.) The `slice()` matters: the attribute's own array must never be transferred. Cleanup adds `api.cpuBench = undefined; api.cancelBench = undefined; benchResolve?.(null)`.

`Scene.tsx` `ViewerApi`: add `cpuBench?: (radius: number) => Promise<{ normals: Uint32Array; ao: Uint8Array; n: number } | null>` and `cancelBench?: () => void`.

- [ ] **Step 5: Panel "Benchmark" group**

Selectors: `bench`. Derived: `const benchN = Math.min(total, BENCH_CAP)`, `const canVerify = compute.status === 'built' && total <= BENCH_CAP && bench.status !== 'running' && !!api.readback && !!api.cpuBench`. Handlers:

```tsx
  const runBench = () => { void api.cpuBench?.(radius) }
  const runVerify = async () => {
    if (!api.cpuBench || !api.readback) return
    const [cpu, gpu] = await Promise.all([api.cpuBench(compute.builtRadius ?? radius), api.readback()])
    if (!cpu) return
    const verify = compareResults(gpu.normals, gpu.ao, cpu.normals, cpu.ao, cpu.n)
    store.set({ bench: { ...store.get().bench, verify } })
  }
```

(import `compareResults` from `'../compute/verify'`, `BENCH_CAP` from `'../compute/params'`.) Group after Compute:

```tsx
      <div className={styles.group}>
        <div className={styles.groupTitle}>Benchmark (CPU, {benchN.toLocaleString()} pts)</div>
        {bench.status === 'running'
          ? <button className={styles.button} onClick={() => api.cancelBench?.()}>Cancel ({Math.round(bench.progress * 100)}%)</button>
          : <button className={styles.button} disabled={status !== 'ready' || !api.cpuBench} onClick={runBench}>Run CPU</button>}
        {bench.cpuMs && compute.timings.length > 0 && (
          <div className={styles.table}>
            <span>pass</span><span>GPU ms</span><span>CPU ms</span>
            <span>hash</span><span>{gpuSum(['count', 'scan', 'scatter'])}</span><span>{bench.cpuMs.hash.toFixed(0)}</span>
            <span>normals</span><span>{gpuSum(['normals'])}</span><span>{bench.cpuMs.normals.toFixed(0)}</span>
            <span>ao</span><span>{gpuSum(['ao'])}</span><span>{bench.cpuMs.ao.toFixed(0)}</span>
          </div>
        )}
        <button className={styles.button} disabled={!canVerify} onClick={() => void runVerify()}>Verify GPU vs CPU</button>
        {total > BENCH_CAP && <div className={styles.muted}>Verify needs the same points on both sides — demo set only.</div>}
        {bench.verify && <div className={styles.muted}>n {bench.verify.n.toLocaleString()} · median {bench.verify.medianDeg.toFixed(3)}° · max {bench.verify.maxDeg.toFixed(2)}° · AO MAE {bench.verify.aoMae.toFixed(4)} · non-finite {bench.verify.nonFinite} · +Z {bench.verify.degenerate.toLocaleString()}</div>}
      </div>
```

with `const gpuSum = (passes: string[]) => { const rows = compute.timings.filter((t) => passes.includes(t.pass)); return rows.some((t) => t.gpuMs === null) ? 'n/a' : rows.reduce((a, t) => a + (t.gpuMs ?? 0), 0).toFixed(2) }`. Note the GPU column shows the numbers from the full-N build while CPU is capped at `benchN` — label the table header `GPU ms (N = total)` vs `CPU ms (N = benchN)` when they differ.

- [ ] **Step 6: Gates + browser (demo)**

`npx tsc --noEmit && npx vitest run && npm run build` → green. Playwright: demo, wait load, Build (wait `Built`), click "Run CPU" — `browser_wait_for` text `Run CPU` (button label returns after done; allow up to 120 s: 2M points × (kNN + PCA) in JS is 20–60 s). Record `store.bench.cpuMs` (expose `window.__pcvCompute.bench = () => store.get().bench` in DEV). Click Verify → wait for the `median` text; record `medianDeg`, `maxDeg`, `aoMae`, `nonFinite`, `degenerate`. Acceptance: median < 1°, nonFinite 0. If median ≥ 1°: compare a few points by hand (`__pcvCompute.readback()` vs `cpuCellStart` neighbours) — usual causes: f32 vs f64 eigen decomposition on near-degenerate neighbourhoods (report the distribution: fraction > 1°), or PCA sample set mismatch (both must include the point itself). Cancel path: click Run CPU, then Cancel within ~2 s → status `cancelled`, button returns.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/loader src/viewer/compute src/viewer/render/Scene.tsx src/viewer/ui/Panel.tsx
git commit -m "compute: cpu benchmark in the loader worker, verify gpu vs cpu"
```

---

### Task 7: 20M build, docs, spec status

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-09-15-phase-4-compute-design.md`, `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` (§7 item 4 → **Done.**), `docs/superpowers/specs/2026-09-17-spec-review-phases-3-6.md` (Phase 4 block → applied)

- [ ] **Step 1: 20M build (browser)**

`http://localhost:5173/?data=full`, `browser_wait_for` `loaded 20,000,000/20,000,000` (do not poll). Build with the default radius (3 × spacing ≈ 0.67 m). `browser_wait_for` text `Built` (allow up to 60 s). Record the five-row timings + wall ms, console status (0 errors), `draws`/frame ms unchanged after build, and Lit + AO screenshot `.playwright-mcp/shading-litao-20m.png`. Record the memory: computed buffers `qpos 160 + flags 20 + normals 80 + ao 20 + cellStart 16.8 + cellCursor 16.8 + blockSums 0.07 + sorted 80 ≈ 394 MB`. Run CPU (prefix subsample, 2M) for the timing row; Verify is disabled — confirm the note shows.

- [ ] **Step 2: README**

Status: `Phase 4 done: GPU normals + AO (spatial hash, PCA, tangent-plane AO), shading modes, CPU benchmark + verify.` Perf: add a table

```
| pass | GPU ms @2M | GPU ms @20M | CPU ms @2M (worker) |
|---|---|---|---|
| hash (count+scan+scatter) | … | … | … |
| normals (k=16) | … | … | … |
| ao | … | … | … |
| **total** | … | … | … |
Verify @2M: median <…>°, max <…>°, AO MAE <…>, non-finite 0.
```

Controls: panel row gains `build normals + AO (radius ×spacing), shading (flat / lit / lit + AO), CPU benchmark, verify`.

- [ ] **Step 3: ARCHITECTURE "## Compute (phase 4)"** (after Post-processing, before Phase 0 findings)

Cover: buffers table with measured MB (per ruling 2 the +100 MB is allocated at load); hash sizing (A4) and measured occupancy; pass order and dispatch shapes (`.compute(N,[64])`, scan thread-per-block serial, why no workgroup memory); atomics via `.toAtomic()` + `atomicLoad/Store` in non-atomic kernels; shared `wgsl()` helpers; timing semantics (submit vs gpu, timestamp quantisation, `hasFeature`); kernel rules re-affirmed; shading math (headlight `max(|n·v|, 0.15)`, AO byte, `vertexStage`); CPU path (worker, `benchWords` subsample, cooperative slices, cancel); Verify method + numbers; 20M numbers; console status; Deferred triage (compute buffers join the renderer leak; `K` fallback; Verify on > 2M sets; hash buffers not freed).

- [ ] **Step 4: Spec updates**

Phase 4 spec: append "Plan rulings (2026-09-18)" pointing at this plan's table (scan without workgroup memory, atomic node policy, zero kernel, hash buffers kept, Verify ≤ cap, dequant sharing via `dequantScale`). Master spec §7 item 4 → `**Done.**`. Review doc Phase 4 block: `**Applied 2026-09-18 (plan)**` line.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/
git commit -m "phase 4: docs (compute section, perf table, spec rulings)"
```

---

### Task 8: Gates, whole-branch review, merge

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run && npm run build && tools/.venv/bin/pytest tools/tests -q` — all green; final browser console check on the demo (0 errors, 2 benign warnings).
- [ ] **Step 2:** Whole-branch review vs the spec's acceptance list and this plan's rulings: every kernel `.toVar()`-ed and returns `u32`; no `toReadOnly()`; `ao` writes thread-per-word; `vertexStage` around everything index-derived in `colorNode`; no `window`/`document` listeners; `src/viewer/` self-contained; no new deps.
- [ ] **Step 3:** Merge (`git checkout main && git merge --no-ff phase-4-compute -m "merge phase-4-compute" && git push origin main && git branch -d phase-4-compute`), then `/deslop` over `src/viewer/compute/**`, `pointMaterial.ts`, `Panel.tsx`, `useLoader.ts`, `loader.worker.ts`, committed to `main`.

---

## Self-review

**Spec coverage.** Layout: the spec's `hash.wgsl.ts`/`normals.wgsl.ts`/`ao.wgsl.ts` became `compute/wgsl/{hash,normals,ao}.ts` + `helpers.ts` (shared code node) — same responsibilities. Inputs (`qpos`, dequant, manifest) ✓ ruling 1. Parameters (radius default/slider, k, eps) ✓ Tasks 0/5. Buffers table ✓ (+ `blockSums`, and normals/ao at load per ruling 2). Passes 1–5 ✓ Tasks 4–5 (scan per extra ruling; zero kernel per ruling 6). Dispatch shape ✓. Timing ✓ Task 4. UI: Build button gating ✓, shading select ✓, bench section ✓, Verify ✓ Task 6. CPU path in the worker with transfer/progress/cancel ✓ Task 3/6. Acceptance: 2M timings (5.6), 20M build + memory (7.1), Verify numbers (6.6), shading screenshots/seams (5.6), console/timestamps (5.6, 7.1). Risks: atomics spike (4.6), scan vs CPU (4.6 + vitest), dispatch limits (20M build), readback only ≤ 2M (ruling), register pressure (5.6 note), collisions (occupancy recorded). Tests: kNN vs brute force ✓, Jacobi ✓, oct round-trip ✓, scan ✓, AO plane/corner ✓, Playwright smoke ✓. Docs ✓ Task 7.

**Placeholder scan.** Task 7's `…` cells are measurement inputs filled from Tasks 5–7. No other slots.

**Type consistency.** `PassTiming`/`ComputeState`/`BenchState`/`VerifyResult` (Task 0) are what `timing.ts`, `pipeline.ts`, `ComputeRunner`, `useLoader`, `Panel`, `verify.ts` use; `ComputePipeline.readback()` shape matches `ViewerApi.readback` and `compareResults` (`gpuAo` packed `Uint32Array`, `cpuAo` `Uint8Array`); `CpuInput` fields equal the `cpuBench` message fields; `benchWords`/`tableSizeFor`/`spacingOf` names match across `params.ts`, `useLoader`, `Panel`; kernel parameter names in `wgsl/*.ts` match the object keys in `pipeline.ts` (`qpos, cellStart, cellCursor, blockSums, sorted, normals, ao, i, w, b, count, blocks, tableSize, dqScale, radius, mask, eps, n`).

## Unresolved questions

- Verify only on ≤ 2M sets (same points both sides) — ok, or run GPU on the subsample too?
- Keep hash buffers (34 MB) allocated after build vs. spec's "freed"? (no three free API; ruling = keep)
- `+100 MB` normals/ao at load (ruling 2a) acceptable for the 20M memory story?
