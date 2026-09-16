# Phase 2: Viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the spike with `PointCloudViewer`: a manifest dataset streamed by a worker into one global GPU buffer, rendered as per-chunk sprites with orbit, point budget, point size, three colour modes, a wired flags buffer, HUD, theme tokens and focus-scoped keys.

**Architecture:** Main thread fetches + validates the manifest, allocates one `StorageBufferAttribute` for positions (`N × 2` u32) and one for flags (`ceil(N/4)` u32), and spawns a module worker that Range-fetches chunks by camera distance and transfers each back for a partial upload (`addUpdateRange`). One `PointsNodeMaterial` on `Sprite`s reads positions/flags from storage in the vertex stage using `userData('chunkBase') + instanceIndex`; every chunk is its own `Sprite` with a tiny `PlaneGeometry` carrying the chunk bounds. Viewer state is a hand-rolled `useSyncExternalStore` store, one per viewer instance.

**Tech Stack:** three 0.186.0 (`three/webgpu`, `three/tsl`), @react-three/fiber 9.7.0, @react-three/drei 10.7.8, react 19.3.0, vite 8.3.0, TypeScript, vitest (node env), Playwright MCP for browser checks.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-2-viewer-design.md` (parent `2026-09-15-point-cloud-editor-design.md`, amendments A3, A6, A7, A8)

## Global Constraints

- Pinned exact: `three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.0`. No new runtime deps this phase.
- WebGPU required. No WebGL fallback. Unsupported browser → message. Compatibility-mode device → message (spec "GPU buffers").
- Compute/shader code: TSL + raw WGSL via `wgslFn` + `storage()` nodes. No `renderer.backend` internals except the read of `backend.compatibilityMode` the spec asks for.
- No leva. UI hand-rolled. `src/viewer/` self-contained, CSS modules only, no global CSS.
- Point format v1: `[u16 x][u16 y][u16 z][u16 packed = intensity | (class << 8)]`, little-endian, 8 B/pt; loaded as `Uint32Array` (2 words/pt).
- Flags: u8 per point packed 4/u32, bits `hidden=1, selected=2, deleted=4, splitA=8, splitB=16`. Same `storage()` node in compute and vertex; never `toReadOnly()`.
- Hidden/deleted points collapse the quad (`sizeNode = 0`, A8). Never move them to a huge position.
- Everything derived from the point index inside `colorNode` is wrapped in `vertexStage()`.
- Keyboard handlers on the viewer root only. Nothing on `window`/`document`.
- Repo public, MIT. Branch per phase, merge to main. Commit messages: concise, no attribution lines.
- vitest runs with `environment: 'node'` (`vite.config.ts`): unit tests only import pure modules; anything touching DOM/WebGPU is verified in the browser.
- Browser checks: Playwright MCP tools (`browser_navigate`, `browser_console_messages`, `browser_take_screenshot`, `browser_evaluate`). Read `#hud` text via `browser_evaluate`. No human in the loop.
- `public/data/demo/{manifest.json,points.bin}` exists from Phase 1 (`npm run data:demo`). If not, run it first; the browser tasks cannot proceed without it.

---

### Task 1: Branch, store, manifest loader

**Files:**
- Create: `src/viewer/state/store.ts`
- Create: `src/viewer/loader/manifest.ts`
- Test: `src/viewer/state/store.test.ts`, `src/viewer/loader/manifest.test.ts`

**Interfaces:**
- Produces: `ViewerState`, `initialState`, `Store<T> = { get(): T; set(patch: Partial<T>): void; subscribe(fn: () => void): () => void }`, `createStore<T>(initial: T): Store<T>`, `StoreContext`, `useStore<S>(selector: (s: ViewerState) => S): S`, `useViewerStore(): Store<ViewerState>`.
- Produces: `Bounds` (re-export), `ManifestChunk { offset; count; bounds }`, `Manifest`, `validateManifest(json: unknown): Manifest` (throws `Error`), `resolveBinUrl(manifestUrl: string, file: string): string`, `fetchManifest(url: string, fetchFn?: typeof fetch): Promise<{ manifest: Manifest; binUrl: string }>`.

- [ ] **Step 1: Create branch**

```bash
cd ~/Developer/Graphics/TS_PointCloud
git checkout -b phase-2-viewer
```

- [ ] **Step 2: Store tests**

`src/viewer/state/store.test.ts`:
```ts
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
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/viewer/state`
Expected: FAIL, `Cannot find module './store'`.

- [ ] **Step 4: Store implementation**

`src/viewer/state/store.ts`:
```ts
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Manifest } from '../loader/manifest'

export type ColorMode = 'height' | 'intensity' | 'class'
export type Colormap = 'viridis' | 'turbo' | 'grayscale'

export interface ViewerState {
  manifest: Manifest | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  loaded: { points: number; chunks: number }
  budget: number
  pointSize: number
  colorMode: ColorMode
  colormap: Colormap
  showHud: boolean
}

export const initialState: ViewerState = {
  manifest: null,
  status: 'idle',
  loaded: { points: 0, chunks: 0 },
  budget: 1,
  pointSize: 2,
  colorMode: 'height',
  colormap: 'viridis',
  showHud: true,
}

export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(fn: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      subs.forEach((fn) => fn())
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
}

export const StoreContext = createContext<Store<ViewerState> | null>(null)

export function useViewerStore(): Store<ViewerState> {
  const s = useContext(StoreContext)
  if (!s) throw new Error('useViewerStore outside <PointCloudViewer>')
  return s
}

export function useStore<S>(selector: (s: ViewerState) => S): S {
  const store = useViewerStore()
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()))
}
```
`useStore` re-renders when the selected value's identity changes; select primitives or stable objects (`loaded` is replaced only on upload, so selecting `s.loaded` is fine).

- [ ] **Step 5: Manifest tests**

`src/viewer/loader/manifest.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { validateManifest, resolveBinUrl, fetchManifest } from './manifest'

const good = {
  version: 1, name: 'demo', units: 'm', bytesPerPoint: 8, file: 'points.bin',
  bounds: { min: [0, 0, 0], max: [100, 100, 10] }, pointCount: 30,
  classMap: { '2': 'Ground' },
  chunks: [
    { offset: 0, count: 10, bounds: { min: [0, 0, 0], max: [50, 50, 10] } },
    { offset: 10, count: 20, bounds: { min: [50, 0, 0], max: [100, 100, 10] } },
  ],
}

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const m = validateManifest(good)
    expect(m.pointCount).toBe(30)
    expect(m.chunks.length).toBe(2)
  })
  it('rejects wrong version', () => {
    expect(() => validateManifest({ ...good, version: 2 })).toThrow(/version/)
  })
  it('rejects bytesPerPoint != 8', () => {
    expect(() => validateManifest({ ...good, bytesPerPoint: 12 })).toThrow(/bytesPerPoint/)
  })
  it('rejects non-contiguous chunks', () => {
    const bad = { ...good, chunks: [good.chunks[0], { ...good.chunks[1], offset: 11 }] }
    expect(() => validateManifest(bad)).toThrow(/contiguous/)
  })
  it('rejects chunk sum != pointCount', () => {
    expect(() => validateManifest({ ...good, pointCount: 31 })).toThrow(/pointCount/)
  })
  it('rejects non-object', () => {
    expect(() => validateManifest(null)).toThrow()
  })
})

describe('resolveBinUrl', () => {
  it('resolves relative to the manifest url', () => {
    expect(resolveBinUrl('https://x.test/data/demo/manifest.json', 'points.bin'))
      .toBe('https://x.test/data/demo/points.bin')
    expect(resolveBinUrl('http://localhost:5173/data/demo/manifest.json', 'points.bin'))
      .toBe('http://localhost:5173/data/demo/points.bin')
  })
})

describe('fetchManifest', () => {
  it('fetches, validates, resolves bin url', async () => {
    const fetchFn = (async () => new Response(JSON.stringify(good), { status: 200 })) as unknown as typeof fetch
    const r = await fetchManifest('https://x.test/d/manifest.json', fetchFn)
    expect(r.binUrl).toBe('https://x.test/d/points.bin')
    expect(r.manifest.name).toBe('demo')
  })
  it('throws on HTTP error', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(fetchManifest('https://x.test/d/manifest.json', fetchFn)).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/viewer/loader/manifest`
Expected: FAIL, `Cannot find module './manifest'`.

- [ ] **Step 7: Manifest implementation**

`src/viewer/loader/manifest.ts`:
```ts
import type { Bounds } from '../format/quant'
export type { Bounds }

export interface ManifestChunk { offset: number; count: number; bounds: Bounds }

export interface Manifest {
  version: 1
  name: string
  source?: string
  license?: string
  crs?: string
  units: 'm'
  bounds: Bounds
  pointCount: number
  bytesPerPoint: 8
  file: string
  classMap: Record<string, string>
  chunks: ManifestChunk[]
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}
function isBounds(b: unknown): b is Bounds {
  return typeof b === 'object' && b !== null && isVec3((b as Bounds).min) && isVec3((b as Bounds).max)
}

export function validateManifest(json: unknown): Manifest {
  if (typeof json !== 'object' || json === null) throw new Error('manifest: not an object')
  const m = json as Record<string, unknown>
  if (m.version !== 1) throw new Error(`manifest: unsupported version ${String(m.version)}`)
  if (m.bytesPerPoint !== 8) throw new Error(`manifest: bytesPerPoint must be 8, got ${String(m.bytesPerPoint)}`)
  if (typeof m.file !== 'string') throw new Error('manifest: file missing')
  if (typeof m.pointCount !== 'number') throw new Error('manifest: pointCount missing')
  if (!isBounds(m.bounds)) throw new Error('manifest: bounds invalid')
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) throw new Error('manifest: chunks missing')
  let next = 0
  for (const c of m.chunks as ManifestChunk[]) {
    if (typeof c.offset !== 'number' || typeof c.count !== 'number' || !isBounds(c.bounds)) throw new Error('manifest: chunk invalid')
    if (c.offset !== next) throw new Error(`manifest: chunks not contiguous at offset ${c.offset}, expected ${next}`)
    next += c.count
  }
  if (next !== m.pointCount) throw new Error(`manifest: chunks sum ${next} != pointCount ${m.pointCount}`)
  return {
    version: 1,
    name: typeof m.name === 'string' ? m.name : 'dataset',
    source: typeof m.source === 'string' ? m.source : undefined,
    license: typeof m.license === 'string' ? m.license : undefined,
    crs: typeof m.crs === 'string' ? m.crs : undefined,
    units: 'm',
    bounds: m.bounds,
    pointCount: m.pointCount,
    bytesPerPoint: 8,
    file: m.file,
    classMap: (typeof m.classMap === 'object' && m.classMap !== null ? m.classMap : {}) as Record<string, string>,
    chunks: m.chunks as ManifestChunk[],
  }
}

export function resolveBinUrl(manifestUrl: string, file: string): string {
  return new URL(file, manifestUrl).href
}

export async function fetchManifest(url: string, fetchFn: typeof fetch = fetch): Promise<{ manifest: Manifest; binUrl: string }> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status} for ${url}`)
  const manifest = validateManifest(await res.json())
  // Relative props like "/data/demo/manifest.json" resolve against the page; absolute URLs pass through.
  const absolute = new URL(url, globalThis.location?.href ?? 'http://localhost/').href
  return { manifest, binUrl: resolveBinUrl(absolute, manifest.file) }
}
```
`globalThis.location` is `undefined` in vitest's node environment, so the tests use absolute manifest URLs.

- [ ] **Step 8: Run tests, type-check, commit**

Run: `npx vitest run src/viewer && npx tsc --noEmit`
Expected: PASS (store 4, manifest 8, plus the phase-0 quant/synthetic suites), no TS errors.

```bash
git add src/viewer/state src/viewer/loader
git commit -m "viewer: store + manifest loader"
```

---

### Task 2: Chunk queue, fetch logic, loader worker

**Files:**
- Create: `src/viewer/loader/chunkQueue.ts`, `src/viewer/loader/fetchChunks.ts`, `src/viewer/loader/loader.worker.ts`
- Test: `src/viewer/loader/chunkQueue.test.ts`, `src/viewer/loader/fetchChunks.test.ts`

**Interfaces:**
- Produces: `ChunkRef { index: number; offset: number; count: number; centre: [number, number, number] }`, `class ChunkQueue { constructor(chunks: ChunkRef[]); setCamera(pos: [number, number, number]): void; pop(): ChunkRef | undefined; readonly size: number }`.
- Produces: `rangeHeader(c: ChunkRef): string`, `sliceChunk(full: ArrayBuffer, c: ChunkRef): Uint32Array`, `LoaderIO { fetch: typeof fetch; post(index: number, words: Uint32Array): void; signal: AbortSignal; concurrency?: number }`, `fetchAll(binUrl: string, queue: ChunkQueue, io: LoaderIO): Promise<void>`.
- Produces worker protocol: in `{ type: 'start'; binUrl: string; chunks: ChunkRef[] } | { type: 'camera'; pos: [number, number, number] } | { type: 'dispose' }`; out `{ type: 'chunk'; index: number; words: Uint32Array } | { type: 'done' } | { type: 'error'; message: string }`. Exported as `LoaderIn` / `LoaderOut` types from `fetchChunks.ts`.

- [ ] **Step 1: Queue tests**

`src/viewer/loader/chunkQueue.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/viewer/loader/chunkQueue`
Expected: FAIL, `Cannot find module './chunkQueue'`.

- [ ] **Step 3: Queue implementation**

`src/viewer/loader/chunkQueue.ts`:
```ts
export interface ChunkRef {
  index: number
  offset: number
  count: number
  centre: [number, number, number]
}

export class ChunkQueue {
  private items: ChunkRef[]
  private cam: [number, number, number] = [0, 0, 0]
  private dirty = true

  constructor(chunks: ChunkRef[]) {
    this.items = chunks.slice()
  }

  setCamera(pos: [number, number, number]): void {
    this.cam = pos
    this.dirty = true
  }

  get size(): number { return this.items.length }

  pop(): ChunkRef | undefined {
    if (this.dirty) {
      const [cx, cy, cz] = this.cam
      const d2 = (c: ChunkRef) => (c.centre[0] - cx) ** 2 + (c.centre[1] - cy) ** 2 + (c.centre[2] - cz) ** 2
      this.items.sort((a, b) => d2(b) - d2(a))   // farthest first so pop() from the end is nearest
      this.dirty = false
    }
    return this.items.pop()
  }
}
```

- [ ] **Step 4: Fetch-logic tests (mocked fetch, both paths)**

`src/viewer/loader/fetchChunks.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ChunkQueue, type ChunkRef } from './chunkQueue'
import { rangeHeader, sliceChunk, fetchAll } from './fetchChunks'

const chunks: ChunkRef[] = [
  { index: 0, offset: 0, count: 3, centre: [0, 0, 0] },
  { index: 1, offset: 3, count: 2, centre: [1, 0, 0] },
]
// 5 points × 2 words; word value = point index * 10 + word
const full = new Uint32Array(10).map((_, i) => Math.floor(i / 2) * 10 + (i % 2))

describe('rangeHeader / sliceChunk', () => {
  it('range covers offset*8 .. (offset+count)*8-1', () => {
    expect(rangeHeader(chunks[1])).toBe('bytes=24-39')
  })
  it('slice returns the chunk words as a fresh buffer', () => {
    const w = sliceChunk(full.buffer, chunks[1])
    expect(Array.from(w)).toEqual([30, 31, 40, 41])
    expect(w.buffer).not.toBe(full.buffer)
  })
})

function rangeFetch(log: string[], url = 'https://cdn.test/points.bin'): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')!
    log.push(`${String(input)} ${range}`)
    const [a, b] = range.replace('bytes=', '').split('-').map(Number)
    const body = full.buffer.slice(a, b + 1)
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/40` } })
  }) as unknown as typeof fetch
}

describe('fetchAll', () => {
  it('Range path: posts each chunk with the right words, nearest first', async () => {
    const log: string[] = []
    const posted: [number, number[]][] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([1, 0, 0])
    await fetchAll('https://x.test/points.bin', q, {
      fetch: rangeFetch(log), post: (i, w) => posted.push([i, Array.from(w)]), signal: new AbortController().signal, concurrency: 1,
    })
    expect(posted).toEqual([[1, [30, 31, 40, 41]], [0, [0, 1, 10, 11, 20, 21]]])
    expect(log[0]).toBe('https://x.test/points.bin bytes=24-39')
    expect(log.length).toBe(chunks.length)   // one request per chunk, nothing extra
  })
  it('Range path with concurrency 4 still issues exactly one request per chunk', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    await fetchAll('https://x.test/points.bin', q, { fetch: rangeFetch(log), post: () => {}, signal: new AbortController().signal, concurrency: 4 })
    expect(log.length).toBe(chunks.length)
  })
  it('reuses response.url for subsequent chunks after the first response', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    // Response.url is read-only; emulate a redirect by returning a Response whose url getter reports the CDN
    const f = rangeFetch(log)
    const withUrl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await f(input, init)
      Object.defineProperty(r, 'url', { value: 'https://cdn.test/signed/points.bin' })
      return r
    }) as unknown as typeof fetch
    await fetchAll('https://x.test/points.bin', q, { fetch: withUrl, post: () => {}, signal: new AbortController().signal, concurrency: 1 })
    expect(log[0].startsWith('https://x.test/')).toBe(true)
    expect(log[1].startsWith('https://cdn.test/signed/')).toBe(true)
  })
  it('falls back to binUrl once when the reused url fails', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    const f = rangeFetch(log)
    let calls = 0
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      if (calls === 1) { const r = await f(input, init); Object.defineProperty(r, 'url', { value: 'https://cdn.test/expired' }); return r }
      if (String(input).includes('expired')) { log.push(`${String(input)} 403`); return new Response('', { status: 403 }) }
      return f(input, init)
    }) as unknown as typeof fetch
    const posted: number[] = []
    await fetchAll('https://x.test/points.bin', q, { fetch: flaky, post: (i) => posted.push(i), signal: new AbortController().signal, concurrency: 1 })
    expect(posted.sort()).toEqual([0, 1])
    expect(log.some((l) => l.endsWith('403'))).toBe(true)
    expect(log[log.length - 1].startsWith('https://x.test/')).toBe(true)
  })
  it('full-fetch fallback: 200 without Content-Range → exactly one fetch even at concurrency 4, all chunks sliced locally', async () => {
    let fetches = 0
    const fullFetch = (async () => { fetches++; return new Response(full.buffer.slice(0), { status: 200 }) }) as unknown as typeof fetch
    const posted: [number, number[]][] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    await fetchAll('https://x.test/points.bin', q, { fetch: fullFetch, post: (i, w) => posted.push([i, Array.from(w)]), signal: new AbortController().signal, concurrency: 4 })
    expect(fetches).toBe(1)
    expect(posted.sort((a, b) => a[0] - b[0])).toEqual([[0, [0, 1, 10, 11, 20, 21]], [1, [30, 31, 40, 41]]])
  })
  it('stops on abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const q = new ChunkQueue(chunks)
    const posted: number[] = []
    await fetchAll('https://x.test/points.bin', q, { fetch: rangeFetch([]), post: (i) => posted.push(i), signal: ac.signal })
    expect(posted).toEqual([])
  })
})
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run src/viewer/loader/fetchChunks`
Expected: FAIL, `Cannot find module './fetchChunks'`.

- [ ] **Step 6: Fetch-logic implementation**

`src/viewer/loader/fetchChunks.ts`:
```ts
import type { ChunkQueue, ChunkRef } from './chunkQueue'

export type LoaderIn =
  | { type: 'start'; binUrl: string; chunks: ChunkRef[] }
  | { type: 'camera'; pos: [number, number, number] }
  | { type: 'dispose' }
export type LoaderOut =
  | { type: 'chunk'; index: number; words: Uint32Array }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface LoaderIO {
  fetch: typeof fetch
  post(index: number, words: Uint32Array): void
  signal: AbortSignal
  concurrency?: number
}

export function rangeHeader(c: ChunkRef): string {
  return `bytes=${c.offset * 8}-${(c.offset + c.count) * 8 - 1}`
}

export function sliceChunk(full: ArrayBuffer, c: ChunkRef): Uint32Array {
  return new Uint32Array(full.slice(c.offset * 8, (c.offset + c.count) * 8))
}

export async function fetchAll(binUrl: string, queue: ChunkQueue, io: LoaderIO): Promise<void> {
  if (io.signal.aborted) return
  const first = queue.pop()
  if (!first) return
  let url = binUrl           // switches to response.url after the first response (skips the 302 per chunk)

  const fetchOne = (c: ChunkRef, target: string): Promise<Response> =>
    io.fetch(target, { headers: { Range: rangeHeader(c) }, signal: io.signal })

  const fetchChunk = async (c: ChunkRef): Promise<Response> => {
    let res = await fetchOne(c, url)
    if (!res.ok && url !== binUrl) {          // reused CDN url expired → retry from the origin once
      url = binUrl
      res = await fetchOne(c, url)
    }
    if (!res.ok) throw new Error(`chunk ${c.index}: HTTP ${res.status}`)
    return res
  }

  const postRange = async (c: ChunkRef, res: Response): Promise<void> => {
    const buf = await res.arrayBuffer()
    if (buf.byteLength !== c.count * 8) throw new Error(`chunk ${c.index}: expected ${c.count * 8} bytes, got ${buf.byteLength}`)
    io.post(c.index, new Uint32Array(buf))
  }

  // Discovery is serialised: the first chunk alone decides the mode (Range vs full file) and
  // yields the post-redirect URL. Only then does the pool start, so the full-fetch fallback
  // never downloads the file more than once.
  const res = await fetchChunk(first)
  if (res.status === 200 && !res.headers.get('Content-Range')) {
    const full = await res.arrayBuffer()
    io.post(first.index, sliceChunk(full, first))
    for (let c = queue.pop(); c && !io.signal.aborted; c = queue.pop()) io.post(c.index, sliceChunk(full, c))
    return
  }
  if (res.url && res.url !== url) url = res.url
  await postRange(first, res)

  const workers = Array.from({ length: io.concurrency ?? 4 }, async () => {
    for (;;) {
      if (io.signal.aborted) return
      const c = queue.pop()
      if (!c) return
      await postRange(c, await fetchChunk(c))
    }
  })
  await Promise.all(workers)
}
```
Range mode issues exactly one request per chunk (plus at most one origin retry after an expired CDN URL); full mode issues exactly one request total and slices every chunk from that body.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/viewer/loader`
Expected: PASS (chunkQueue 3, fetchChunks 8, manifest 8).

- [ ] **Step 8: Worker entry**

`src/viewer/loader/loader.worker.ts`:
```ts
import { ChunkQueue } from './chunkQueue'
import { fetchAll, type LoaderIn, type LoaderOut } from './fetchChunks'

const ctx = self as unknown as { postMessage(msg: LoaderOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<LoaderIn>) => void) | null }
let queue: ChunkQueue | null = null
let ac: AbortController | null = null

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'camera') { queue?.setCamera(msg.pos); return }
  if (msg.type === 'dispose') { ac?.abort(); queue = null; return }
  queue = new ChunkQueue(msg.chunks)
  ac = new AbortController()
  fetchAll(msg.binUrl, queue, {
    fetch: (input, init) => fetch(input, init),
    post: (index, words) => ctx.postMessage({ type: 'chunk', index, words }, [words.buffer]),
    signal: ac.signal,
  })
    .then(() => ctx.postMessage({ type: 'done' }))
    .catch((err: unknown) => { if (!ac?.signal.aborted) ctx.postMessage({ type: 'error', message: String(err) }) })
}
```

- [ ] **Step 9: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: no errors (`tsconfig` `lib` includes `DOM`; the worker file uses `self` via the cast above).

```bash
git add src/viewer/loader
git commit -m "viewer: chunk queue, range fetch with fallback, loader worker"
```

---

### Task 3: Colormaps and point buffers

**Files:**
- Create: `src/viewer/render/colormaps.ts`, `src/viewer/render/PointBuffers.ts`
- Test: `src/viewer/render/colormaps.test.ts`, `src/viewer/render/PointBuffers.test.ts`

**Interfaces:**
- Produces: `viridis(t: number): [number, number, number]`, `turbo(t)`, `grayscale(t)` (0–1 floats), `ASPRS_COLORS: Record<number, [number, number, number]>` (0–255 ints), `ASPRS_FALLBACK`, `buildLut(kind: 'viridis' | 'turbo' | 'grayscale' | 'class'): Uint8Array` (1024 bytes RGBA), `makeLutTexture(kind): DataTexture`.
- Produces: `FLAG_HIDDEN = 1, FLAG_SELECTED = 2, FLAG_DELETED = 4, FLAG_SPLIT_A = 8, FLAG_SPLIT_B = 16`, `PointBuffers { count; qpos: StorageBufferAttribute; flags: StorageBufferAttribute; qposNode: StorageBufferNode<'uvec2'>; flagsNode: StorageBufferNode<'uint'>; loaded: Uint8Array; uploadRange(offset: number, words: Uint32Array): void; dispose(): void }`, `createPointBuffers(count: number, chunkCount: number): PointBuffers`.

- [ ] **Step 1: Colormap tests**

`src/viewer/render/colormaps.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { viridis, turbo, grayscale, buildLut, ASPRS_COLORS } from './colormaps'

describe('colormaps', () => {
  it('viridis runs dark purple → yellow', () => {
    const [r0, g0, b0] = viridis(0)
    expect(r0).toBeLessThan(0.35); expect(g0).toBeLessThan(0.1); expect(b0).toBeGreaterThan(0.3)
    const [r1, g1, b1] = viridis(1)
    expect(r1).toBeGreaterThan(0.9); expect(g1).toBeGreaterThan(0.85); expect(b1).toBeLessThan(0.25)
  })
  it('turbo runs dark blue → dark red', () => {
    const [r0, , b0] = turbo(0)
    expect(r0).toBeLessThan(0.3); expect(b0).toBeGreaterThan(0.2)
    const [r1, g1, b1] = turbo(1)
    expect(r1).toBeGreaterThan(0.4); expect(g1).toBeLessThan(0.15); expect(b1).toBeLessThan(0.15)
  })
  it('grayscale is linear', () => {
    expect(grayscale(0.5)).toEqual([0.5, 0.5, 0.5])
  })
  it('lut is 256 RGBA8 texels, alpha 255, clamped', () => {
    const lut = buildLut('viridis')
    expect(lut.length).toBe(1024)
    expect(lut[3]).toBe(255)
    expect(Math.max(...lut)).toBeLessThanOrEqual(255)
  })
  it('class lut puts the ASPRS colour at index = class', () => {
    const lut = buildLut('class')
    expect(Array.from(lut.subarray(6 * 4, 6 * 4 + 3))).toEqual(ASPRS_COLORS[6])
    expect(Array.from(lut.subarray(2 * 4, 2 * 4 + 3))).toEqual(ASPRS_COLORS[2])
    expect(Array.from(lut.subarray(200 * 4, 200 * 4 + 3))).toEqual(ASPRS_COLORS[-1])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/viewer/render/colormaps`
Expected: FAIL, `Cannot find module './colormaps'`.

- [ ] **Step 3: Colormap implementation**

`src/viewer/render/colormaps.ts`:
```ts
import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, SRGBColorSpace } from 'three/webgpu'

type RGB = [number, number, number]
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

// Viridis polynomial fit (M. Zucker, degree 6), sRGB in [0,1]
const V = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
]
export function viridis(t: number): RGB {
  t = clamp01(t)
  const out: RGB = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    let v = V[6][ch]
    for (let k = 5; k >= 0; k--) v = V[k][ch] + t * v
    out[ch] = clamp01(v)
  }
  return out
}

// Turbo polynomial approximation (Google, A. Mikhailov), sRGB in [0,1]
const TR4 = [0.13572138, 4.6153926, -42.66032258, 132.13108234], TR2 = [-152.94239396, 59.28637943]
const TG4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333], TG2 = [4.27729857, 2.82956604]
const TB4 = [0.1066733, 12.64194608, -60.58204836, 110.36276771], TB2 = [-89.90310912, 41.04993063]
export function turbo(t: number): RGB {
  const x = clamp01(t)
  const v4 = [1, x, x * x, x * x * x], v2 = [x ** 4, x ** 5]
  const ev = (a: number[], b: number[]) => a[0] * v4[0] + a[1] * v4[1] + a[2] * v4[2] + a[3] * v4[3] + b[0] * v2[0] + b[1] * v2[1]
  return [clamp01(ev(TR4, TR2)), clamp01(ev(TG4, TG2)), clamp01(ev(TB4, TB2))]
}

export function grayscale(t: number): RGB {
  const v = clamp01(t)
  return [v, v, v]
}

// ASPRS classes → sRGB bytes; -1 is the fallback for classes not listed
export const ASPRS_COLORS: Record<number, RGB> = {
  [-1]: [106, 106, 106],
  0: [77, 77, 77],      // never classified
  1: [154, 154, 154],   // unclassified
  2: [160, 120, 75],    // ground
  3: [127, 191, 77],    // low vegetation
  4: [86, 163, 62],     // medium vegetation
  5: [47, 125, 50],     // high vegetation
  6: [224, 160, 64],    // building
  7: [255, 59, 208],    // low noise
  9: [47, 128, 237],    // water
  17: [192, 192, 192],  // bridge deck   (addition beyond the spec's minimum list)
  18: [255, 59, 208],   // high noise    (addition beyond the spec's minimum list)
}

export type LutKind = 'viridis' | 'turbo' | 'grayscale' | 'class'

export function buildLut(kind: LutKind): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    let rgb: RGB
    if (kind === 'class') {
      const c = ASPRS_COLORS[i] ?? ASPRS_COLORS[-1]
      rgb = [c[0] / 255, c[1] / 255, c[2] / 255]
    } else {
      const f = kind === 'viridis' ? viridis : kind === 'turbo' ? turbo : grayscale
      rgb = f(i / 255)
    }
    out[i * 4] = Math.round(rgb[0] * 255)
    out[i * 4 + 1] = Math.round(rgb[1] * 255)
    out[i * 4 + 2] = Math.round(rgb[2] * 255)
    out[i * 4 + 3] = 255
  }
  return out
}

export function makeLutTexture(kind: LutKind): DataTexture {
  const tex = new DataTexture(buildLut(kind), 256, 1, RGBAFormat, UnsignedByteType)
  tex.colorSpace = SRGBColorSpace      // values are sRGB; decoded on sample (rgba8unorm-srgb)
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}
```

- [ ] **Step 4: Run colormap tests**

Run: `npx vitest run src/viewer/render/colormaps`
Expected: PASS, 5 tests. (`DataTexture` import is fine in node; only `makeLutTexture` touches it and no test calls it.)

- [ ] **Step 5: PointBuffers tests**

`src/viewer/render/PointBuffers.test.ts`:
```ts
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
    expect(b.qpos.needsUpdate).toBe(true)
  })
  it('flag constants match the spec bits', () => {
    expect(FLAG_HIDDEN).toBe(1)
    expect(FLAG_DELETED).toBe(4)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/viewer/render/PointBuffers`
Expected: FAIL, `Cannot find module './PointBuffers'`.

- [ ] **Step 7: PointBuffers implementation**

`src/viewer/render/PointBuffers.ts`:
```ts
import { StorageBufferAttribute } from 'three/webgpu'
import type { StorageBufferNode } from 'three/webgpu'
import { storage } from 'three/tsl'

export const FLAG_HIDDEN = 1
export const FLAG_SELECTED = 2
export const FLAG_DELETED = 4
export const FLAG_SPLIT_A = 8
export const FLAG_SPLIT_B = 16

export interface PointBuffers {
  count: number
  qpos: StorageBufferAttribute
  flags: StorageBufferAttribute
  qposNode: StorageBufferNode<'uvec2'>
  flagsNode: StorageBufferNode<'uint'>
  loaded: Uint8Array           // 1 per chunk once uploaded
  uploadRange(offset: number, words: Uint32Array): void
  dispose(): void
}

export function createPointBuffers(count: number, chunkCount: number): PointBuffers {
  const qpos = new StorageBufferAttribute(new Uint32Array(count * 2), 2)
  const flags = new StorageBufferAttribute(new Uint32Array(Math.ceil(count / 4)), 1)
  // Same node bound read_write in compute (later phases) and read in vertex; never toReadOnly().
  const qposNode = storage(qpos, 'uvec2', count)
  const flagsNode = storage(flags, 'uint', Math.ceil(count / 4))
  return {
    count, qpos, flags, qposNode, flagsNode,
    loaded: new Uint8Array(chunkCount),
    uploadRange(offset, words) {
      ;(qpos.array as Uint32Array).set(words, offset * 2)
      qpos.addUpdateRange(offset * 2, words.length)
      qpos.needsUpdate = true
    },
    dispose() {
      // Node.dispose() only dispatches a 'dispose' event; the GPU buffers themselves are
      // reclaimed when the renderer is disposed on <Canvas> unmount.
      qposNode.dispose()
      flagsNode.dispose()
    },
  }
}
```
`needsUpdate = true` bumps `version`; three's `WebGPUAttributeUtils.updateAttribute` uploads only `updateRanges` and then calls `clearUpdateRanges()`. If several chunks arrive between frames their ranges accumulate and are all uploaded on the next render.

- [ ] **Step 8: Run tests, type-check, commit**

Run: `npx vitest run src/viewer/render && npx tsc --noEmit`
Expected: PASS (colormaps 5, PointBuffers 3), no TS errors. If `@types/three` types `updateRanges` as `Array<{start: number; count: number}>` the `toEqual` passes as written.

```bash
git add src/viewer/render
git commit -m "viewer: colormap luts + global point/flags storage buffers"
```

---

### Task 4: Point material, chunk sprites, scene, HUD

**Files:**
- Create: `src/viewer/render/pointMaterial.ts`, `src/viewer/render/ChunkSprites.tsx`, `src/viewer/render/Scene.tsx`, `src/viewer/ui/Hud.tsx`
- Reference (do not modify yet): `src/spike/SpikeApp.tsx` (renderer factory), `src/spike/Hud.tsx`

**Interfaces:**
- Consumes: `PointBuffers`, `Manifest`, `makeLutTexture`, store.
- Produces: `PointMaterialHandle { material: PointsNodeMaterial; setLut(kind: LutKind): void; setMode(mode: ColorMode): void; setPointSize(px: number): void; setRefDist(d: number): void; dispose(): void }`, `createPointMaterial(buffers: PointBuffers, manifest: Manifest, centroid: [number, number, number]): PointMaterialHandle`.
- Produces: `centroidOf(b: Bounds): [number, number, number]`, `<ChunkSprites buffers manifest handle centroid />`, `<Scene store buffers manifest handle centroid api hudEl />` where `ViewerApi = { fit: () => void; sendCamera?: (pos: [number, number, number]) => void }` is a mutable object owned by `PointCloudViewer`, `<Hud el />`.

- [ ] **Step 1: Point material**

`src/viewer/render/pointMaterial.ts`:
```ts
import * as THREE from 'three/webgpu'
import { clamp, float, instanceIndex, positionView, select, texture, uniform, uint, userData, vec2, vec3, vertexStage } from 'three/tsl'
import type { PointBuffers } from './PointBuffers'
import { FLAG_HIDDEN, FLAG_DELETED } from './PointBuffers'
import type { Manifest } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import { makeLutTexture, type LutKind } from './colormaps'
import type { ColorMode } from '../state/store'

export interface PointMaterialHandle {
  material: THREE.PointsNodeMaterial
  setLut(kind: LutKind): void
  setMode(mode: ColorMode): void
  setPointSize(px: number): void
  setRefDist(d: number): void
  dispose(): void
}

const MODE: Record<ColorMode, number> = { height: 0, intensity: 1, class: 2 }

export function createPointMaterial(buffers: PointBuffers, manifest: Manifest, centroid: [number, number, number]): PointMaterialHandle {
  const b = manifest.bounds
  const dqScale = uniform(new THREE.Vector3(...dequantScale(b)))
  const dqMinCentred = uniform(new THREE.Vector3(b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]))
  const pointSize = uniform(2)
  const refDist = uniform(1000)
  const mode = uniform(0)

  // Global point index: per-object chunk base + instance index. Read in the vertex stage only.
  const gi = userData('chunkBase', 'uint').add(instanceIndex)
  const w = buffers.qposNode.element(gi)
  const x = w.x.bitAnd(uint(0xffff))
  const y = w.x.shiftRight(uint(16))
  const z = w.y.bitAnd(uint(0xffff))
  const packed = w.y.shiftRight(uint(16))
  const intensity = packed.bitAnd(uint(0xff))
  const cls = packed.shiftRight(uint(8)).bitAnd(uint(0xff))

  const fword = buffers.flagsNode.element(gi.shiftRight(uint(2)))
  const fbyte = fword.shiftRight(gi.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))
  const collapsed = fbyte.bitAnd(uint(FLAG_HIDDEN | FLAG_DELETED)).notEqual(uint(0))

  const material = new THREE.PointsNodeMaterial()
  material.sizeAttenuation = false
  material.positionNode = vec3(float(x), float(y), float(z)).mul(dqScale).add(dqMinCentred)
  // A8: hidden/deleted → size 0 collapses the quad (select sits outside the clamp).
  const sizePx = clamp(pointSize.mul(refDist).div(positionView.z.negate()), 1, 8)
  material.sizeNode = select(collapsed, float(0), sizePx)

  // Colour: t chosen per mode; wrapped in vertexStage so the storage reads stay in the vertex stage.
  const tH = float(z).div(65535)
  const tI = float(intensity).div(255)
  const tC = float(cls).div(255)
  const t = select(mode.equal(1), tI, select(mode.equal(2), tC, tH))
  const tV = vertexStage(t)
  const lutNode = texture(makeLutTexture('viridis'), vec2(tV, 0.5))
  material.colorNode = lutNode

  const luts = new Map<LutKind, THREE.DataTexture>()
  const lutFor = (kind: LutKind) => {
    let tex = luts.get(kind)
    if (!tex) { tex = makeLutTexture(kind); luts.set(kind, tex) }
    return tex
  }
  lutNode.value.dispose()   // replace the bootstrap texture with the cached one
  lutNode.value = lutFor('viridis')

  return {
    material,
    setLut: (kind) => { lutNode.value = lutFor(kind) },
    setMode: (m) => { mode.value = MODE[m] },
    setPointSize: (px) => { pointSize.value = px },
    setRefDist: (d) => { refDist.value = d },
    dispose: () => { luts.forEach((t) => t.dispose()); material.dispose() },
  }
}
```
Type notes: `userData(name, inputType)` returns `UserDataNode` (verified in `@types/three`), `vertexStage` is a typed export, `positionView` is `Node<'vec3'>`. If `mode.equal(1)` complains about a number argument, use `mode.equal(float(1))`. If `lutNode.value` is typed read-only, cast `(lutNode as unknown as { value: THREE.Texture }).value = …` and note it in ARCHITECTURE.

- [ ] **Step 2: Chunk sprites**

`src/viewer/render/ChunkSprites.tsx`:
```tsx
import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import type { Bounds } from '../format/quant'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import { useStore } from '../state/store'

export function centroidOf(b: Bounds): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
}

export function ChunkSprites({ buffers, manifest, handle, centroid }: {
  buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle; centroid: [number, number, number]
}) {
  const sprites = useMemo(() => manifest.chunks.map((c) => {
    const geometry = new THREE.PlaneGeometry(1, 1)      // own geometry: bounds live on it
    const [cx, cy, cz] = centroid
    const box = new THREE.Box3(
      new THREE.Vector3(c.bounds.min[0] - cx, c.bounds.min[1] - cy, c.bounds.min[2] - cz),
      new THREE.Vector3(c.bounds.max[0] - cx, c.bounds.max[1] - cy, c.bounds.max[2] - cz),
    )
    geometry.boundingBox = box
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
    const s = new THREE.Sprite(handle.material)
    s.geometry = geometry
    s.count = 0
    s.userData.chunkBase = c.offset
    // Sprite.intersectsFrustum ignores geometry bounds; route through the manual sphere (phase 0).
    s.intersectsFrustum = (frustum: THREE.Frustum) => frustum.intersectsObject(s)
    return s
  }), [manifest, handle, centroid])

  const loaded = useStore((s) => s.loaded)
  const budget = useStore((s) => s.budget)
  // Layout effect: r3f's rAF loop runs outside React's paint cycle, so counts must be
  // written synchronously after commit for the change to land in the same frame (spec acceptance).
  useLayoutEffect(() => {
    manifest.chunks.forEach((c, i) => {
      sprites[i].count = buffers.loaded[i] ? Math.ceil(c.count * budget) : 0
    })
  }, [sprites, manifest, buffers, loaded, budget])

  useEffect(() => () => sprites.forEach((s) => s.geometry.dispose()), [sprites])

  return <>{sprites.map((s, i) => <primitive key={i} object={s} />)}</>
}
```

- [ ] **Step 3: HUD**

`src/viewer/ui/Hud.tsx` (generalised from `src/spike/Hud.tsx`):
```tsx
import { useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'
import { useStore, useViewerStore } from '../state/store'

export function Hud({ el }: { el: RefObject<HTMLDivElement | null> }) {
  const { gl } = useThree()
  const info = (gl as unknown as WebGPURenderer).info
  const store = useViewerStore()
  const show = useStore((s) => s.showHud)
  const ema = useRef(16)
  const last = useRef(performance.now())
  // info.autoReset is off (renderer factory); read the previous frame's counters, then clear them.
  useFrame(() => {
    const now = performance.now()
    ema.current = ema.current * 0.9 + (now - last.current) * 0.1
    last.current = now
    if (!el.current) return
    const { loaded, manifest, budget } = store.get()
    el.current.textContent = show
      ? `${ema.current.toFixed(2)} ms  ${(1000 / ema.current).toFixed(0)} fps  draws ${info.render.drawCalls}  tris ${info.render.triangles}` +
        `  loaded ${loaded.points.toLocaleString()}/${(manifest?.pointCount ?? 0).toLocaleString()}  budget ${Math.round(budget * 100)}%`
      : ''
    info.reset()
  })
  return null
}
```

- [ ] **Step 4: Scene with renderer factory, camera fit, controls**

`src/viewer/render/Scene.tsx`:
```tsx
import { useEffect, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import type { Store, ViewerState } from '../state/store'
import { ChunkSprites } from './ChunkSprites'
import { Hud } from '../ui/Hud'

export interface ViewerApi {
  fit: () => void
  sendCamera?: (pos: [number, number, number]) => void
}

function fitDistance(manifest: Manifest, fovDeg: number): number {
  const b = manifest.bounds
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2]
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
  return radius / Math.sin((fovDeg * Math.PI) / 360) * 1.1
}

function CameraRig({ manifest, handle, api }: { manifest: Manifest; handle: PointMaterialHandle; api: ViewerApi }) {
  const { camera } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const lastSent = useRef(0)
  useEffect(() => {
    const fit = () => {
      const cam = camera as THREE.PerspectiveCamera
      const d = fitDistance(manifest, cam.fov)
      const dir = new THREE.Vector3(1, -1, 0.8).normalize()
      cam.position.copy(dir.multiplyScalar(d))
      cam.near = d / 1000
      cam.far = d * 10
      cam.updateProjectionMatrix()
      controls.current?.target.set(0, 0, 0)
      controls.current?.update()
      handle.setRefDist(d)
    }
    api.fit = fit
    fit()
  }, [camera, manifest, handle, api])
  // Throttled camera position to the loader (100 ms) for chunk prioritisation.
  useFrame(() => {
    const now = performance.now()
    if (now - lastSent.current < 100 || !api.sendCamera) return
    lastSent.current = now
    api.sendCamera([camera.position.x, camera.position.y, camera.position.z])
  })
  return <OrbitControls ref={controls} makeDefault enableDamping />
}

export function Scene({ store, buffers, manifest, handle, centroid, api, hudEl }: {
  store: Store<ViewerState>; buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle
  centroid: [number, number, number]; api: ViewerApi; hudEl: RefObject<HTMLDivElement | null>
}) {
  return (
    <Canvas
      camera={{ position: [1, -1, 0.8], near: 0.1, far: 10000, fov: 50, up: [0, 0, 1] }}
      gl={async (props) => {
        // Same adapter options as WebGPUBackend.init; request the adapter's own storage-binding limit (phase 0).
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: props.powerPreference as GPUPowerPreference,
          featureLevel: 'compatibility',
        })
        const renderer = new THREE.WebGPURenderer({
          ...(props as Record<string, unknown>),
          antialias: false,
          trackTimestamp: true,
          requiredLimits: adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : undefined,
        })
        await renderer.init()
        renderer.info.autoReset = false   // Hud owns info.reset()
        const maxBinding = adapter?.limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024
        const compat = (renderer.backend as unknown as { compatibilityMode: boolean | null }).compatibilityMode
        if (compat) store.set({ status: 'error', error: 'WebGPU compatibility mode not supported (no storage buffers in the vertex stage).' })
        else if (buffers.count * 8 > maxBinding) store.set({ status: 'error', error: `Dataset too large for this GPU: ${buffers.count.toLocaleString()} points need ${(buffers.count * 8 / 2 ** 20).toFixed(0)} MiB in one storage binding, limit ${(maxBinding / 2 ** 20).toFixed(0)} MiB.` })
        return renderer
      }}
    >
      <ChunkSprites buffers={buffers} manifest={manifest} handle={handle} centroid={centroid} />
      <CameraRig manifest={manifest} handle={handle} api={api} />
      <Hud el={hudEl} />
    </Canvas>
  )
}
```
`three-stdlib` is a dependency of drei (already installed); importing only its type is fine. If `tsc` cannot resolve `three-stdlib`, use `useRef<React.ComponentRef<typeof OrbitControls>>(null)` instead.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: no errors. Fix any TSL typing mismatch with the narrow casts described in Step 1 and record each in ARCHITECTURE "Type deviations".

```bash
git add src/viewer/render src/viewer/ui
git commit -m "viewer: point material, chunk sprites, scene, hud"
```

---

### Task 5: useLoader, PointCloudViewer, App — mergeable midpoint

**Files:**
- Create: `src/viewer/loader/useLoader.ts`, `src/viewer/PointCloudViewer.tsx`, `src/viewer/PointCloudViewer.module.css`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: `useLoader(store, manifestUrl): { buffers, manifest, binUrl, handle, centroid } | null`, `<PointCloudViewer manifestUrl theme? className? />` (public).

- [ ] **Step 1: useLoader**

`src/viewer/loader/useLoader.ts`:
```ts
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchManifest, type Manifest } from './manifest'
import type { LoaderIn, LoaderOut } from './fetchChunks'
import type { ChunkRef } from './chunkQueue'
import { createPointBuffers, type PointBuffers } from '../render/PointBuffers'
import { createPointMaterial, type PointMaterialHandle } from '../render/pointMaterial'
import { centroidOf } from '../render/ChunkSprites'
import type { Store, ViewerState } from '../state/store'
import type { ViewerApi } from '../render/Scene'

export interface Loaded {
  manifest: Manifest
  binUrl: string
  buffers: PointBuffers
  handle: PointMaterialHandle
  centroid: [number, number, number]
}

export function useLoader(store: Store<ViewerState>, manifestUrl: string, api: ViewerApi): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const uploadLog = useRef<number[]>([])

  useEffect(() => {
    let cancelled = false
    store.set({ status: 'loading', error: undefined, manifest: null, loaded: { points: 0, chunks: 0 } })
    fetchManifest(manifestUrl).then(({ manifest, binUrl }) => {
      if (cancelled) return
      const centroid = centroidOf(manifest.bounds)
      const buffers = createPointBuffers(manifest.pointCount, manifest.chunks.length)
      const handle = createPointMaterial(buffers, manifest, centroid)
      store.set({ manifest })
      setLoaded({ manifest, binUrl, buffers, handle, centroid })
    }).catch((err: unknown) => {
      if (!cancelled) store.set({ status: 'error', error: String(err) })
    })
    return () => { cancelled = true }
  }, [store, manifestUrl])

  useEffect(() => {
    if (!loaded) return
    const { manifest, binUrl, buffers, centroid } = loaded
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })
    const chunks: ChunkRef[] = manifest.chunks.map((c, index) => {
      const cc = centroidOf(c.bounds)
      return { index, offset: c.offset, count: c.count, centre: [cc[0] - centroid[0], cc[1] - centroid[1], cc[2] - centroid[2]] }
    })
    let points = 0, n = 0
    worker.onmessage = (e: MessageEvent<LoaderOut>) => {
      const msg = e.data
      if (msg.type === 'chunk') {
        const t0 = performance.now()
        buffers.uploadRange(manifest.chunks[msg.index].offset, msg.words)
        uploadLog.current.push(performance.now() - t0)
        buffers.loaded[msg.index] = 1
        points += manifest.chunks[msg.index].count
        n += 1
        store.set({ loaded: { points, chunks: n } })
        if (import.meta.env.DEV) console.debug(`[loader] chunk ${msg.index} (${manifest.chunks[msg.index].count} pts) ${n}/${manifest.chunks.length}`)
      } else if (msg.type === 'done') {
        store.set({ status: 'ready' })
      } else {
        store.set({ status: 'error', error: msg.message })
      }
    }
    const start: LoaderIn = { type: 'start', binUrl, chunks }
    worker.postMessage(start)
    api.sendCamera = (pos) => { const m: LoaderIn = { type: 'camera', pos }; worker.postMessage(m) }
    return () => {
      const m: LoaderIn = { type: 'dispose' }
      worker.postMessage(m)
      worker.terminate()
      api.sendCamera = undefined
    }
  }, [loaded, store, api])

  useEffect(() => () => { loaded?.handle.dispose(); loaded?.buffers.dispose() }, [loaded])

  return useMemo(() => loaded, [loaded])
}
```
The `console.debug` upload-order log is the spec's "dev log of upload order"; it is stripped in production by the `import.meta.env.DEV` guard. `uploadLog` feeds Task 6's measurement.

- [ ] **Step 2: PointCloudViewer**

`src/viewer/PointCloudViewer.module.css`:
```css
.root { position: relative; width: 100%; height: 100%; min-height: 240px; outline: none; background: var(--pcv-bg); color: var(--pcv-text); font: 12px/1.4 var(--pcv-mono); }
.hud { position: absolute; top: 8px; left: 8px; z-index: 1; white-space: pre; pointer-events: none; }
.message { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; }
```

`src/viewer/PointCloudViewer.tsx`:
```tsx
import { useMemo, useRef, type KeyboardEvent } from 'react'
import { StoreContext, createStore, initialState, useStore, useViewerStore } from './state/store'
import { useLoader } from './loader/useLoader'
import { Scene, type ViewerApi } from './render/Scene'
import styles from './PointCloudViewer.module.css'
import tokens from './theme/tokens.module.css'

export interface PointCloudViewerProps {
  manifestUrl: string
  theme?: 'dark' | 'light'
  className?: string
}

// One store per viewer instance, provided via context so several viewers can coexist on a page.
export function PointCloudViewer(props: PointCloudViewerProps) {
  const store = useMemo(() => createStore(initialState), [])
  return (
    <StoreContext.Provider value={store}>
      <ViewerInner {...props} />
    </StoreContext.Provider>
  )
}

function ViewerInner({ manifestUrl, theme, className }: PointCloudViewerProps) {
  const store = useViewerStore()
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const hudEl = useRef<HTMLDivElement>(null)
  const api = useRef<ViewerApi>({ fit: () => {} }).current
  const loaded = useLoader(store, manifestUrl, api)
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator

  // Keys live on the root only (focus-scoped); nothing is attached to window/document.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'f' || e.key === 'F') { api.fit(); e.preventDefault() }
    if (e.key === 'h' || e.key === 'H') { store.set({ showHud: !store.get().showHud }); e.preventDefault() }
  }

  return (
    <div className={`${tokens.root} ${styles.root} ${className ?? ''}`} data-theme={theme} tabIndex={0} onKeyDown={onKeyDown}>
      <div id="hud" ref={hudEl} className={styles.hud} />
      {!hasGpu && <div className={styles.message}>WebGPU not available in this browser.</div>}
      {hasGpu && status === 'error' && <div className={styles.message}>{error}</div>}
      {hasGpu && status !== 'error' && loaded && (
        <Scene store={store} buffers={loaded.buffers} manifest={loaded.manifest} handle={loaded.handle}
          centroid={loaded.centroid} api={api} hudEl={hudEl} />
      )}
    </div>
  )
}
```
`tokens.module.css` gets its real content in Task 7; for this task create `src/viewer/theme/tokens.module.css` containing only `.root {}` so the import resolves.

- [ ] **Step 3: Mount in App**

`src/App.tsx`:
```tsx
import { PointCloudViewer } from './viewer/PointCloudViewer'

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl="/data/demo/manifest.json" />
    </div>
  )
}
```
`index.html` already sizes `#root` to 100%.

- [ ] **Step 4: Type-check, unit tests, dev server**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no TS errors; all suites pass.

Run: `npm run dev` (background) and confirm `public/data/demo/manifest.json` is served: `curl -sI http://localhost:5173/data/demo/manifest.json | head -1` → `HTTP/1.1 200 OK`.

- [ ] **Step 5: Browser check (Playwright MCP)**

1. `browser_navigate` → `http://localhost:5173/`.
2. `browser_console_messages`: 0 errors (the two benign three warnings from phase 0 are allowed).
3. `browser_evaluate` `() => document.querySelector('#hud')?.textContent` every ~500 ms until `loaded 2,000,000/2,000,000`; record the time from navigation to full load (acceptance: < 3 s on localhost) and note when the first `loaded` value became non-zero (< 1 s).
4. Read HUD: `tris` must equal `2 × loaded points + 1` at budget 100 %.
5. `browser_take_screenshot` → note the file; cloud visible, coloured by height (viridis), camera fitted.
6. `browser_evaluate` `() => { const e = document.querySelector('.root, [tabindex="0"]'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true })) }` then read HUD → empty string; send `h` again → text returns.
7. Console log order: `browser_console_messages` filtered for `[loader]`; the first chunks listed should be the ones nearest the initial camera position (corner `(1,-1,0.8)` direction from the centre). Record the first five indices in ARCHITECTURE.

If step 4 shows `tris 1` with points loaded → the `userData` chunkBase read or the storage read failed; check `browser_console_messages` for a WGSL compile error and apply the spec fallback (one material per chunk: call `createPointMaterial` per chunk with a `uniform(chunkBase)` instead of `userData`). Record which path shipped.

- [ ] **Step 6: Commit (mergeable midpoint)**

```bash
git add src/viewer src/App.tsx
git commit -m "viewer: streaming loader, PointCloudViewer, app mounts demo"
```
This commit is the spec's mergeable midpoint: the demo renders progressively with orbit and HUD. Do not merge yet unless the phase is being split; continue with Task 6.

---

### Task 6: Partial-upload measurement and userData check

**Files:**
- Modify: `docs/ARCHITECTURE.md` (new "Phase 2" section)
- Temporary: `src/viewer/loader/useLoader.ts` already records per-chunk upload ms in `uploadLog`

- [ ] **Step 1: Expose the log in dev**

In `useLoader.ts`, after `store.set({ status: 'ready' })` add (dev-only):
```ts
if (import.meta.env.DEV) (window as unknown as { __pcvUploadMs?: number[] }).__pcvUploadMs = uploadLog.current
```

- [ ] **Step 2: Measure on demo and (if present) full set**

Note: `uploadRange` timing measures the CPU `array.set` + range bookkeeping only; the GPU upload happens on the next render inside three. Measure that too: in the browser, `browser_evaluate`:
```js
() => { const l = window.__pcvUploadMs; return { n: l.length, maxMs: Math.max(...l).toFixed(3), medianMs: l.slice().sort((a,b)=>a-b)[l.length>>1].toFixed(3) } }
```
Then the frame-time signature: with `?` nothing else, watch the HUD `ms` while chunks arrive; a full-buffer re-upload each frame at 2M would show 16 MB/frame copies (several ms) throughout loading; partial updates show a spike only on the first chunk. If `npm run data:full` was run, repeat with `/data/full/manifest.json` (temporarily change `App.tsx` or add `?manifest=` handling — do not commit the temporary change) and record both.

Record in `docs/ARCHITECTURE.md` under `## Phase 2: viewer`:
- per-chunk CPU upload ms (n, median, max) at 2M and 20M,
- HUD frame ms during streaming vs after,
- whether the first `needsUpdate` uploaded the whole buffer (one-time cost) — visible as a single long frame,
- `userData('chunkBase')` result (worked / fallback used),
- draw calls at 100 % budget = chunk count (+1 output blit).

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md src/viewer/loader/useLoader.ts
git commit -m "viewer: record partial-upload and chunkBase measurements"
```

---

### Task 7: Panel, theme tokens, controls wiring

**Files:**
- Create: `src/viewer/theme/tokens.module.css` (replace the stub), `src/viewer/ui/Panel.tsx`, `src/viewer/ui/Panel.module.css`
- Modify: `src/viewer/PointCloudViewer.tsx` (mount Panel, wire handle setters)

**Interfaces:**
- Consumes: store, `PointMaterialHandle`.
- Produces: `<Panel handle />`.

- [ ] **Step 1: Theme tokens**

`src/viewer/theme/tokens.module.css`:
```css
/* --pcv-* consume Lab's tokens when embedded (lab/src/theme/tokens.css); fall back to our own palette standalone. */
.root {
  --pcv-bg: var(--bg, #0a0a0a);
  --pcv-surface: var(--bg-surface, #141414);
  --pcv-card: var(--bg-card, #1a1a1a);
  --pcv-text: var(--text-primary, #e0e0e0);
  --pcv-text-2: var(--text-secondary, #999);
  --pcv-muted: var(--text-muted, #666);
  --pcv-border: var(--border, #222);
  --pcv-accent: var(--accent, #BF1656);
  --pcv-font: var(--font-body, 'Manrope', sans-serif);
  --pcv-mono: var(--font-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace);
  --pcv-radius: var(--radius, 10px);
}
.root[data-theme="light"] {
  --pcv-bg: var(--bg, #fcfcfc);
  --pcv-surface: var(--bg-surface, #f5f5f5);
  --pcv-card: var(--bg-card, #fff);
  --pcv-text: var(--text-primary, #111);
  --pcv-text-2: var(--text-secondary, #444);
  --pcv-muted: var(--text-muted, #666);
  --pcv-border: var(--border, #e0e0e0);
  --pcv-accent: var(--accent, #BF1656);
}
```
When Lab sets `--bg` etc. on `<html data-theme=…>`, those win regardless of our `data-theme`; standalone, the viewer's own `theme` prop picks the fallback set.

- [ ] **Step 2: Panel**

`src/viewer/ui/Panel.module.css`:
```css
.panel { position: absolute; top: 8px; right: 8px; z-index: 1; width: 220px; padding: 10px 12px; background: var(--pcv-card); color: var(--pcv-text); border: 1px solid var(--pcv-border); border-radius: var(--pcv-radius); font: 12px/1.5 var(--pcv-font); display: grid; gap: 8px; }
.name { font-weight: 600; }
.muted { color: var(--pcv-muted); }
.bar { height: 4px; background: var(--pcv-surface); border-radius: 2px; overflow: hidden; }
.fill { height: 100%; background: var(--pcv-accent); transition: width 0.1s linear; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; }
.row input[type=range] { width: 100%; grid-column: 1 / -1; accent-color: var(--pcv-accent); }
.row select { grid-column: 1 / -1; background: var(--pcv-surface); color: var(--pcv-text); border: 1px solid var(--pcv-border); border-radius: 4px; padding: 2px 4px; font: inherit; }
```

`src/viewer/ui/Panel.tsx`:
```tsx
import { useEffect } from 'react'
import { useStore, useViewerStore, type ColorMode, type Colormap } from '../state/store'
import type { PointMaterialHandle } from '../render/pointMaterial'
import styles from './Panel.module.css'

export function Panel({ handle }: { handle: PointMaterialHandle | null }) {
  const store = useViewerStore()
  const manifest = useStore((s) => s.manifest)
  const loaded = useStore((s) => s.loaded)
  const budget = useStore((s) => s.budget)
  const pointSize = useStore((s) => s.pointSize)
  const colorMode = useStore((s) => s.colorMode)
  const colormap = useStore((s) => s.colormap)
  const showHud = useStore((s) => s.showHud)

  useEffect(() => { handle?.setPointSize(pointSize) }, [handle, pointSize])
  useEffect(() => {
    handle?.setMode(colorMode)
    handle?.setLut(colorMode === 'class' ? 'class' : colormap)
  }, [handle, colorMode, colormap])

  const total = manifest?.pointCount ?? 0
  const frac = total ? loaded.points / total : 0
  return (
    <div className={styles.panel}>
      <div className={styles.name}>{manifest?.name ?? 'loading…'}</div>
      <div className={styles.muted}>{loaded.points.toLocaleString()} / {total.toLocaleString()} pts · {loaded.chunks}/{manifest?.chunks.length ?? 0} chunks</div>
      <div className={styles.bar}><div className={styles.fill} style={{ width: `${frac * 100}%` }} /></div>
      <label className={styles.row}><span>Budget</span><span>{Math.round(budget * 100)}%</span>
        <input type="range" min={0} max={100} step={1} value={Math.round(budget * 100)} onChange={(e) => store.set({ budget: Number(e.target.value) / 100 })} /></label>
      <label className={styles.row}><span>Point size</span><span>{pointSize}px</span>
        <input type="range" min={1} max={8} step={1} value={pointSize} onChange={(e) => store.set({ pointSize: Number(e.target.value) })} /></label>
      <label className={styles.row}><span>Colour</span>
        <select value={colorMode} onChange={(e) => store.set({ colorMode: e.target.value as ColorMode })}>
          <option value="height">Height</option><option value="intensity">Intensity</option><option value="class">Classification</option>
        </select></label>
      {colorMode !== 'class' && (
        <label className={styles.row}><span>Colormap</span>
          <select value={colormap} onChange={(e) => store.set({ colormap: e.target.value as Colormap })}>
            <option value="viridis">Viridis</option><option value="turbo">Turbo</option><option value="grayscale">Grayscale</option>
          </select></label>
      )}
      <label className={styles.row}><span>HUD</span>
        <input type="checkbox" checked={showHud} onChange={(e) => store.set({ showHud: e.target.checked })} /></label>
    </div>
  )
}
```

- [ ] **Step 3: Mount the panel**

In `PointCloudViewer.tsx` `ViewerInner`, after the HUD div: `<Panel handle={loaded?.handle ?? null} />`. The panel renders while loading (progress bar) and in error state stays visible above the message.

- [ ] **Step 4: Type-check + tests + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: pass.

```bash
git add src/viewer
git commit -m "viewer: control panel, theme tokens, hud toggle"
```

---

### Task 8: Browser verification — modes, themes, budget, full set

- [ ] **Step 1: Colour modes**

`browser_navigate` `http://localhost:5173/`; wait for full load (HUD). For each of height/intensity/class: `browser_evaluate` sets the select (`document.querySelector('select').value = 'class'; document.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }))` — React listens to the native `change` via its root listener, but the value must be set through the native setter: use
```js
(v) => { const s = document.querySelectorAll('select')[0]; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })) }
```
then `browser_take_screenshot`. Class mode: buildings amber, ground brown, high vegetation green. Intensity: grey-to-yellow viridis by return strength. Also switch colormap to `turbo` and `grayscale` in height mode, screenshot each.

- [ ] **Step 2: Budget and point size**

Set the budget range to 10 via the same native-setter trick on `input[type=range]` (`HTMLInputElement.prototype`, event `input`); read HUD: `tris` = `2 × Σ ceil(count_i × 0.1) + 1` (compute the expected sum from the manifest via `fetch('/data/demo/manifest.json')` in `browser_evaluate` and compare). Set point size 6 → screenshot shows larger dots.

- [ ] **Step 3: Themes**

Temporarily change `App.tsx` to `theme="light"`, reload, screenshot (panel on light card, dark text); revert to no theme, screenshot (dark). Do not commit the temporary change.

- [ ] **Step 4: Full set (if `public/data/full` exists)**

Temporarily point `App.tsx` at `/data/full/manifest.json`. Wait for 100 %; read HUD at budget 100 %, size 2: record ms/fps/draws/tris; acceptance ≥ ~15 fps at DPR 1 (phase-0 baseline). Then set budget 50 % (≈10M) and record. `browser_console_messages`: 0 errors. Revert `App.tsx`. If the full set is not present, write "full set: not run (data:full not fetched)" in ARCHITECTURE.

- [ ] **Step 5: Record**

Append to `docs/ARCHITECTURE.md` Phase 2 section: screenshot list, HUD numbers per configuration, and console status.

```bash
git add docs/ARCHITECTURE.md
git commit -m "viewer: browser verification numbers"
```

---

### Task 9: Delete spike, docs, merge

**Files:**
- Delete: `src/spike/` (all files)
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` (§7 status only)

- [ ] **Step 1: Remove the spike**

```bash
git rm -r src/spike
npx tsc --noEmit && npx vitest run && npm run build
```
Expected: clean; `dist/assets/` contains a separate worker chunk (`loader.worker-*.js`).

- [ ] **Step 2: README**

Replace `## Status` with "Phase 2 done: streaming viewer on the demo set." Replace `## Spike params` with:
```markdown
## Usage
```bash
npm run data:demo   # fetch the 2M demo set into public/data/demo/ (release asset)
npm run dev         # Chrome with WebGPU → http://localhost:5173
```
`<PointCloudViewer manifestUrl="/data/demo/manifest.json" theme="dark" />` — `theme?: 'dark' | 'light'`, `className?`.

## Controls
| Input | Action |
|---|---|
| drag / wheel | orbit / zoom (OrbitControls, +Z up) |
| `F` | refit camera to dataset |
| `H` | toggle HUD |
| panel | point budget %, point size px, colour mode (height / intensity / class), colormap |
Keys work only while the viewer has focus (click it first).
```
Keep the phase-0 spike results table under a `## Phase 0 spike results` heading (numbers are still the baseline).

- [ ] **Step 3: ARCHITECTURE**

Add `## Viewer (phase 2)` above the phase-0 findings: loader (worker, queue, Range + `response.url` reuse, fallback), buffers and upload path (A3, A6, `addUpdateRange`), material (storage reads in vertex, `vertexStage` for colour, A8 size-0 hide, sRGB LUTs), chunk sprites (own geometry for bounds, `intersectsFrustum` override), store, theming (`--pcv-*` over Lab tokens), GPU lifetime note (`PointBuffers.dispose()` only dispatches node events; the buffers are freed when the renderer is disposed on `<Canvas>` unmount), memory table with the main-thread CPU copy (20M: 160 MB positions + 20 MB flags GPU; 160 MB positions array + 20 MB flags array CPU), plus the Task 6/8 measurements. Update master spec §7 item 2 to **Done.**

- [ ] **Step 4: Final checks + merge**

Run: `npx vitest run && npm run build`
Expected: pass.

```bash
git add -A
git commit -m "phase 2: viewer docs, remove spike"
git checkout main
git merge --no-ff phase-2-viewer -m "merge phase-2-viewer"
git branch -d phase-2-viewer
git push origin main
```

---

## Self-review notes

- Spec coverage: store ✓ (T1), manifest validation + binUrl ✓ (T1), chunk queue + camera re-sort ✓ (T2), Range fetch, `response.url` reuse, origin retry, full-fetch fallback, transfers, dispose ✓ (T2), global qpos/flags buffers + `uploadRange` ✓ (T3), colormaps incl. sRGB LUTs + ASPRS ✓ (T3), material with `userData` chunkBase, storage reads, `vertexStage` colour, A8 size-0 hide, perspective px size ✓ (T4), chunk sprites with own geometry bounds + `intersectsFrustum` ✓ (T4), renderer factory with adapter-matched options, `requiredLimits`, compat check, too-large check ✓ (T4), camera fit + `F` ✓ (T4/T5), HUD ✓ (T4), throttled camera → worker ✓ (T4/T5), progressive upload + dev order log ✓ (T5), keys on root only ✓ (T5), panel + theme tokens over Lab names ✓ (T7), acceptance measurements ✓ (T5/T6/T8), spike deletion + docs + merge ✓ (T9).
- Placeholder scan: none. The `PointCloudViewer` Step 2 note instructs removing the indirection before commit; the final shape is provider + inner component using `useViewerStore()`.
- Type consistency: `ChunkRef.centre` used by `ChunkQueue`, `fetchChunks` tests and `useLoader`; `LoaderIn/LoaderOut` shared by worker and hook; `PointMaterialHandle` setters named identically in T4 and T7; `ViewerApi.fit/sendCamera` set in T4's `CameraRig` and T5's `useLoader`; `buffers.loaded` read by `ChunkSprites` and written by `useLoader`.
- Not verified in node_modules (flagged for the executor): `UniformNode.value` assignment typing for `setLut` (`TextureNode.value`), `Sprite.intersectsFrustum` being assignable in `@types/three` (phase 0 code did this and type-checked), `mode.equal(1)` accepting a number literal.
