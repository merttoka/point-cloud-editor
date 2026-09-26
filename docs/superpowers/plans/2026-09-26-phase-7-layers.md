# Phase 7: Layers & Segments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Layers card that lists every LiDAR class and every user-saved segment with visibility, count and click-to-select; selection kernels and CPU ops honour the visibility masks; segments survive export and re-open.

**Architecture:** One `segId` byte per point (`segIds` storage buffer + `segBytes` CPU mirror, packed like `flags`) and a 9-word masks buffer (`classMask`, `segMask[8]`) on `PointBuffers`. The vertex stage multiplies `classBit × segBit` into the size term (masked points collapse like hidden ones) and gains a `segments` colour mode that samples a mutable 256-entry segment LUT. The pick/lasso kernels and every CPU op test the same masks. Pure byte ops live in `edit/layers.ts`; the editor exposes segment/layer methods (outside the undo ring) and `selectLayer` (through the ring, whole-buffer push like a lasso). Export writes `segments.bin` + a `segments` table; the loader restores both before flipping `ready`.

**Tech Stack:** three 0.186.0 (`three/webgpu` + TSL, raw WGSL via `wgslFn`), @react-three/fiber 9.7.0, drei 10.7.8, React 19.3.0, Vite 8.3.0, TypeScript, vitest, `fflate` 0.8.3, pytest (unchanged), Playwright MCP for browser checks (`?bench=1`, `window.__pcv`).

**Spec:** `docs/superpowers/specs/2026-09-26-phase-7-layers-design.md` (binding; its "Decisions" section carries the brainstorm rulings). Master spec `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md`, Amendments A1–A12 win over per-phase text. Context: `docs/ARCHITECTURE.md` § Editing (phase 5), § Bench and deploy (phase 6), § Deferred.

## Global Constraints

- Pinned deps only (`three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `vite@8.3.0`); approved extras vitest, pytest, `fflate@0.8.3`. **No new dependencies.**
- WebGPU only. Compute = raw WGSL via `wgslFn` + `storage()` nodes; every kernel **returns a value and is `.toVar()`-ed** (`call()` in `selectPipeline.ts` does this); never `toReadOnly()` on a shared storage node; flags/segId writes are thread-per-word or atomic (the GPU never writes `segIds` in this phase); `instanceIndex` with an `i ≥ N` guard.
- Hidden/deleted/**masked** points collapse the quad (`sizeNode = 0`), never a huge position (A8). Anything derived from the point index inside `colorNode` goes through `vertexStage()`.
- Vertex-stage mode blends are branchless (`step`/`mix`); the existing nested `select()` on the colour scalar `t` is kept (it reads no `positionView`), the new visibility term is a multiply.
- `src/viewer/` stays self-contained: CSS modules, `--pcv-*` tokens, keys on the viewer root only, **no `window` globals, no URL parsing, no `import.meta.env.DEV`**.
- vitest runs in node: unit tests import pure modules only (importing `three/webgpu` for `StorageBufferAttribute` is fine — `PointBuffers.test.ts` already does). DOM/WebGPU is verified in the browser.
- StrictMode stays on; effects that install `api.*` slots clear them on cleanup.
- Commit messages concise, **no attribution / Co-Authored-By lines**.
- Branch `phase-7-layers` from `main`. Gates before merge: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `tools/.venv/bin/pytest tools/tests -q`; browser checks via `__pcv` at 2M (`?data=demo&bench=1`) and 20M (`?data=full&bench=1`). `README.md` before every push; `docs/ARCHITECTURE.md` on merge; `git merge --no-ff`; delete the branch; `/deslop` over the changed surface after merge.
- A stale vite dev server may own port 5173; use it if it serves this repo, otherwise `npx vite --port 5174` and substitute the port in every URL below. Close other tabs before timing anything (phase 6 finding).

## Rulings (spec checked against the code, 2026-09-26)

1. **Masks live on `PointBuffers.masks`** (`render/layerMasks.ts` factory, created in `createPointBuffers`), so material, select pipeline, editor and the CPU reference share one object. The spec's `LayerMasks` helpers stay pure in the same file.
2. **Segment colours are a 256×1 sRGB `DataTexture` LUT** (`LutKind 'segments'`, same `texture()` path as the class LUT; entry 0 = `#8a8a8a`, never changed) rather than a packed-`0xRRGGBB` storage buffer. Same branchless `t = segId / 255` lookup as `class`, no extra storage read, and the sRGB → linear decode comes from the texture format instead of shader code.
3. **Segment counts are recomputed in `refresh()`** (`countSegments`, one pass over `segBytes` + `flags`, run only while segments exist) instead of decremented inside `del`: undo/redo of a delete, a replace-lasso that later gets deleted, and a re-claim by a newer segment all stay correct without per-op bookkeeping. Count = points carrying the id that are not `DELETED` (hidden ones count). Class counts are computed once at `ready` and never change (spec).
4. **`ready` flips after class counting and the segments import** (`useLoader` `done` handler): `loadMs` includes both; a `segments.bin` fetch failure or length mismatch logs `console.warn` and the dataset still reaches `ready` with no segments.
5. **Segment create/delete/rename/recolour and `selectLayer` require `editor.ready()`** (status ready, not busy); visibility toggles (`setLayerVisible`, `soloLayer`, `showAllLayers`) work any time after the buffers exist.
6. **Ops get a visibility predicate**: `ops.isolate/hide/del(bytes, side, vis)` and `editor.split()` treat a selected point whose layer is masked as not-a-subject. The predicate is the identity when every mask word is `0xffffffff`, so phase 5 timings are unchanged until a layer is hidden.
7. **Class ≥ 31 shares mask bit 31** (spec `min(cls, 31)`), documented in ARCHITECTURE; Vancouver carries classes ≤ 18.
8. **Bench-only slot `api.selectionClasses()`** (installed by `bench/cpuReference.ts`, exposed as `__pcv.selectionClasses()`) counts the selection per class for the acceptance check; `classStats` is a normals/AO stat and is left alone. The handle also gains `colorMode(mode)` and `memory().segIds`.
9. **Layout**: `Panel` and the new `LayersPanel` share a right-hand scroll column (`.side` in `PointCloudViewer.module.css`); `Panel.module.css` `.panel` drops its own absolute positioning. `pointer-events: none` on the column, `auto` on its cards, so the canvas under the empty part of the column still picks.
10. **Export carries every segment row, including count-0 ones**; `segments.bin` is written whenever the table is non-empty. Re-exporting a re-opened export replaces the table with the current one.
11. **`selectLayer` on a fully masked layer is a no-op with no undo entry** (`run()`'s `dropLast()` path), like every other no-op edit.

## Review Focus

1. **A class number ≥ 31** (some LAS files carry 64+): expect hiding class 31 also hides 40 and the list says so — `layerMasks.test.ts` pins `isVisible(words, 40, 0)` to bit 31 (Task 1).
2. **A reused segment id** (delete segment 1, save again): expect the new segment 1 visible with the fresh count, not inheriting the old row's hidden state — `editor.test.ts` "reused id starts visible" (Task 3).
3. **Deleting points inside a segment, then undo**: expect the row count to drop and come back — `editor.test.ts` "del reduces a segment's count; undo restores it" (Task 3).
4. **`segments.bin` shorter than `pointCount`, or a 404**: expect the dataset to reach `ready` without segments and a console warning, never a stuck loading card — `applySegmentBytes` unit test for unknown ids (Task 6) plus the Task 6 browser check with the file renamed.
5. **Export with a count-0 segment in the table**: expect the manifest to keep the row and re-open to show it at 0 — `export.test.ts` "count-0 segment survives the round trip" (Task 6).

---

### Task 1: Store `layers`, `render/layerMasks.ts`, `segIds` on `PointBuffers`, handle slots

**Files:**
- Create: `src/viewer/render/layerMasks.ts`, `src/viewer/render/layerMasks.test.ts`
- Modify: `src/viewer/render/PointBuffers.ts`, `src/viewer/render/PointBuffers.test.ts`, `src/viewer/state/store.ts`, `src/viewer/state/store.test.ts`, `src/viewer/bench/handle.ts`, `src/viewer/bench/handle.test.ts`

**Interfaces:**
- Produces (`render/layerMasks.ts`):
  ```ts
  export const MASK_WORDS = 9            // [classMask, segMask × 8]; bit set = visible
  export const SEG_MAX = 255
  export const classBit = (cls: number) => Math.min(cls, 31)
  export function getBit(words: Uint32Array, word: number, bit: number): boolean
  export function setBit(words: Uint32Array, word: number, bit: number, on: boolean): void
  export const isClassVisible = (words: Uint32Array, cls: number) => boolean
  export const isSegmentVisible = (words: Uint32Array, id: number) => boolean
  export const isVisible = (words: Uint32Array, cls: number, segId: number) => boolean
  export const allVisible = (words: Uint32Array) => boolean
  export function fillVisible(words: Uint32Array): void
  export interface LayerMasks { attr: StorageBufferAttribute; node: StorageBufferNode<'uint'>; words: Uint32Array; upload(): void }
  export function createLayerMasks(): LayerMasks
  ```
- Produces (`render/PointBuffers.ts`): `segIds: StorageBufferAttribute`, `segIdsNode: StorageBufferNode<'uint'>`, `segBytes: Uint8Array`, `uploadSegRange(minIdx, maxIdx): void`, `masks: LayerMasks`.
- Produces (`state/store.ts`):
  ```ts
  export type ColorMode = 'height' | 'intensity' | 'class' | 'segments'
  export interface Segment { id: number; name: string; color: string /* #rrggbb */; count: number; visible: boolean }
  export interface LayersState { classCounts: Record<number, number>; classVisible: Record<number, boolean>; segments: Segment[] }
  ViewerState.layers: LayersState      // initial { classCounts: {}, classVisible: {}, segments: [] }
  export const patchLayers = (store: Store<ViewerState>, p: Partial<LayersState>) => void
  ```
- Produces (`bench/handle.ts`): `MemoryRow.segIds`, `BenchHandle.colorMode(mode: ColorMode): void`, `BenchHandle.selectionClasses(): Record<number, number> | null` (slot filled in Task 5).

- [ ] **Step 1: Write the failing tests for the mask helpers**

`src/viewer/render/layerMasks.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { MASK_WORDS, SEG_MAX, classBit, getBit, setBit, isVisible, isClassVisible, isSegmentVisible, allVisible, fillVisible, createLayerMasks } from './layerMasks'

describe('layer masks', () => {
  it('a fresh mask has every class and segment visible', () => {
    const m = createLayerMasks()
    expect(m.words.length).toBe(MASK_WORDS)
    expect(allVisible(m.words)).toBe(true)
    expect(isVisible(m.words, 6, 0)).toBe(true)
    expect(isVisible(m.words, 6, SEG_MAX)).toBe(true)
  })
  it('class bits are independent below 31; classes ≥ 31 share bit 31', () => {
    const w = new Uint32Array(MASK_WORDS); fillVisible(w)
    setBit(w, 0, classBit(2), false)
    expect(isClassVisible(w, 2)).toBe(false); expect(isClassVisible(w, 6)).toBe(true)
    setBit(w, 0, classBit(31), false)
    expect(isClassVisible(w, 31)).toBe(false); expect(isClassVisible(w, 40)).toBe(false)
    expect(allVisible(w)).toBe(false)
    setBit(w, 0, classBit(2), true); setBit(w, 0, classBit(200), true)
    expect(allVisible(w)).toBe(true)
  })
  it('segment bits span words 1..8; bit 0 of word 1 is the unsegmented layer', () => {
    const w = new Uint32Array(MASK_WORDS); fillVisible(w)
    setBit(w, 1 + (0 >> 5), 0 & 31, false)
    expect(isSegmentVisible(w, 0)).toBe(false); expect(isSegmentVisible(w, 1)).toBe(true)
    setBit(w, 1 + (255 >> 5), 255 & 31, false)
    expect(isSegmentVisible(w, 255)).toBe(false); expect(getBit(w, 8, 31)).toBe(false)
    expect(isVisible(w, 2, 255)).toBe(false); expect(isVisible(w, 2, 7)).toBe(true)
  })
  it('setBit on bit 31 keeps the word unsigned', () => {
    const w = new Uint32Array(MASK_WORDS)
    setBit(w, 0, 31, true)
    expect(w[0]).toBe(0x80000000)
    setBit(w, 0, 31, false)
    expect(w[0]).toBe(0)
  })
  it('upload records one whole-buffer update range', () => {
    const m = createLayerMasks()
    m.upload()
    expect(m.attr.updateRanges).toEqual([{ start: 0, count: MASK_WORDS }])
    expect(m.attr.version).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/viewer/render/layerMasks.test.ts`
Expected: FAIL — cannot resolve `./layerMasks`.

- [ ] **Step 3: Write `render/layerMasks.ts`**

```ts
import { StorageBufferAttribute } from 'three/webgpu'
import type { StorageBufferNode } from 'three/webgpu'
import { storage } from 'three/tsl'

// Layer visibility, read by the vertex stage and the select kernels: word 0 = class mask (bit min(cls, 31)),
// words 1..8 = segment mask (bit per segment id, 256 bits; bit 0 = unsegmented points). Bit set = visible.
export const MASK_WORDS = 9
export const SEG_MAX = 255

export const classBit = (cls: number) => Math.min(cls, 31)
export function getBit(words: Uint32Array, word: number, bit: number): boolean { return ((words[word] >>> bit) & 1) === 1 }
export function setBit(words: Uint32Array, word: number, bit: number, on: boolean): void {
  words[word] = (on ? words[word] | (1 << bit) : words[word] & ~(1 << bit)) >>> 0
}
export const isClassVisible = (words: Uint32Array, cls: number) => getBit(words, 0, classBit(cls))
export const isSegmentVisible = (words: Uint32Array, id: number) => getBit(words, 1 + (id >> 5), id & 31)
export const isVisible = (words: Uint32Array, cls: number, segId: number) => isClassVisible(words, cls) && isSegmentVisible(words, segId)
export const allVisible = (words: Uint32Array) => words.every((w) => w === 0xffffffff)
export function fillVisible(words: Uint32Array): void { words.fill(0xffffffff) }

export interface LayerMasks {
  attr: StorageBufferAttribute
  node: StorageBufferNode<'uint'>
  words: Uint32Array          // = attr.array; mutate with setBit, then upload()
  upload(): void              // whole buffer (36 B)
}

export function createLayerMasks(): LayerMasks {
  const attr = new StorageBufferAttribute(new Uint32Array(MASK_WORDS).fill(0xffffffff), 1)
  const node = storage(attr, 'uint', MASK_WORDS)
  return {
    attr, node, words: attr.array as Uint32Array,
    upload() { attr.addUpdateRange(0, MASK_WORDS); attr.needsUpdate = true },
  }
}
```

- [ ] **Step 4: Run the mask tests**

Run: `npx vitest run src/viewer/render/layerMasks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the failing PointBuffers tests**

Append to `describe('createPointBuffers', …)` in `src/viewer/render/PointBuffers.test.ts`:
```ts
  it('allocates ceil(N/4) segId words, zeroed, with a byte view and a word-aligned upload range', () => {
    const b = createPointBuffers(10, 1)
    expect(b.segIds.array.length).toBe(3)
    expect(b.segBytes.length).toBe(12)
    expect(Array.from(b.segBytes).every((v) => v === 0)).toBe(true)
    b.segBytes[9] = 7
    expect((b.segIds.array as Uint32Array)[2]).toBe(7 << 8)
    b.uploadSegRange(9, 9)
    expect(b.segIds.updateRanges).toEqual([{ start: 2, count: 1 }])
    expect(b.segIds.version).toBe(1)
    expect(b.segIdsNode).toBeDefined()
  })
  it('carries a fresh all-visible layer mask', () => {
    const b = createPointBuffers(10, 1)
    expect(b.masks.words.length).toBe(9)
    expect(Array.from(b.masks.words).every((w) => w === 0xffffffff)).toBe(true)
  })
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/viewer/render/PointBuffers.test.ts`
Expected: FAIL — `b.segIds` undefined.

- [ ] **Step 7: Extend `render/PointBuffers.ts`**

Add the import and fields:
```ts
import { createLayerMasks, type LayerMasks } from './layerMasks'
```
In `PointBuffers`:
```ts
  segIds: StorageBufferAttribute   // u8 segment id per point packed 4/word (0 = none); CPU writes only
  segIdsNode: StorageBufferNode<'uint'>
  segBytes: Uint8Array             // byte i = point i; view over segIds.array.buffer
  uploadSegRange(minIdx: number, maxIdx: number): void   // inclusive point indices → one word-aligned update range
  masks: LayerMasks                // class / segment visibility (read by the vertex stage and the select kernels)
```
In `createPointBuffers`, after `ao`:
```ts
  const segIds = new StorageBufferAttribute(new Uint32Array(flagWords), 1)
  const segIdsNode = storage(segIds, 'uint', flagWords)
  const segBytes = new Uint8Array(segIds.array.buffer)
  const masks = createLayerMasks()
```
In the returned object (next to `flagBytes`/`uploadFlagsRange`):
```ts
    segIds, segIdsNode, segBytes, masks,
    uploadSegRange(minIdx, maxIdx) {
      const w0 = minIdx >> 2, w1 = maxIdx >> 2
      segIds.addUpdateRange(w0, w1 - w0 + 1)
      segIds.needsUpdate = true
    },
```
In `dispose()` add `segIdsNode.dispose()` and `masks.node.dispose()`.

- [ ] **Step 8: Run the PointBuffers tests**

Run: `npx vitest run src/viewer/render/PointBuffers.test.ts`
Expected: PASS.

- [ ] **Step 9: Store types and initial state, with a test**

Append to `src/viewer/state/store.test.ts` inside `describe('createStore', …)`:
```ts
  it('starts with empty layers and patchLayers merges one key', () => {
    const s = createStore(initialState)
    expect(s.get().layers).toEqual({ classCounts: {}, classVisible: {}, segments: [] })
    patchLayers(s, { classCounts: { 2: 5 } })
    expect(s.get().layers.classCounts).toEqual({ 2: 5 })
    expect(s.get().layers.segments).toEqual([])
  })
```
and change the import to `import { createStore, initialState, patchLayers } from './store'`.

In `src/viewer/state/store.ts`:
```ts
export type ColorMode = 'height' | 'intensity' | 'class' | 'segments'
```
After `EditState`:
```ts
export interface Segment { id: number; name: string; color: string /* #rrggbb */; count: number; visible: boolean }
export interface LayersState {
  classCounts: Record<number, number>     // whole class, computed once at ready; only classes with points get rows
  classVisible: Record<number, boolean>   // absent = visible
  segments: Segment[]
}
```
Add `layers: LayersState` to `ViewerState` (after `edit`) and to `initialState`:
```ts
  layers: { classCounts: {}, classVisible: {}, segments: [] },
```
After `patchEdit`:
```ts
export const patchLayers = (store: Store<ViewerState>, p: Partial<LayersState>) => store.set({ layers: { ...store.get().layers, ...p } })
```

- [ ] **Step 10: Handle: `segIds` in memory, `colorMode`, `selectionClasses`**

In `src/viewer/bench/handle.test.ts` change the memory expectations:
```ts
    expect(m.segIds).toBe(20_000_000)
    expect(m.total).toBeGreaterThan(413e6)
```
(replace `toBeGreaterThan(393e6)`; also update the `it(...)` title to `≈414 MB`). In the small-N test add `expect(m.segIds).toBe(8)`.

In `src/viewer/bench/handle.ts`:
```ts
export interface MemoryRow { qpos: number; flags: number; segIds: number; normals: number; ao: number; hash: number; total: number }
```
```ts
  const qpos = pointCount * WORDS_PER_POINT * 4, flags = words, segIds = words, normals = pointCount * 4, ao = words
  return { qpos, flags, segIds, normals, ao, hash, total: qpos + flags + segIds + normals + ao + hash }
```
`BenchHandle` gains, after `shading`:
```ts
  colorMode(mode: ColorMode): void
  selectionClasses(): Record<number, number> | null   // selected points per class (bench CPU pass)
```
Implementation next to `shading`:
```ts
    colorMode(mode) { store.set({ colorMode: mode }) },
    selectionClasses: () => api.selectionClasses?.() ?? null,
```
Import `ColorMode` from the store types. In `src/viewer/render/Scene.tsx` `ViewerApi` add under the bench-only slots:
```ts
  selectionClasses?: () => Record<number, number>                       // selected count per class (CPU pass over the mirror)
```

- [ ] **Step 11: Run all tests and tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green (the `MODE` record in `pointMaterial.ts` will fail tsc on the new `'segments'` member — add `segments: 3` to `MODE` there now; the shader side lands in Task 4).

- [ ] **Step 12: Commit**

```bash
git add src/viewer/render/layerMasks.ts src/viewer/render/layerMasks.test.ts src/viewer/render/PointBuffers.ts src/viewer/render/PointBuffers.test.ts src/viewer/state/store.ts src/viewer/state/store.test.ts src/viewer/bench/handle.ts src/viewer/bench/handle.test.ts src/viewer/render/Scene.tsx src/viewer/render/pointMaterial.ts
git commit -m "layers: masks buffer, segId buffer + mirror, store layers state, handle slots"
```

---

### Task 2: Pure layer byte ops (`edit/layers.ts`)

**Files:**
- Create: `src/viewer/edit/layers.ts`, `src/viewer/edit/layers.test.ts`
- Modify: `src/viewer/edit/ops.ts` (visibility predicate on the three subject ops)

**Interfaces:**
- Consumes: `isSubject(f, side)` from `edit/ops.ts`; `FLAG_*`, `Range` from `edit/flags.ts`; `SEG_MAX` from `render/layerMasks.ts`; `SegmentMeta` (Task 6 adds it to `loader/manifest.ts` — define it there **now** as `export interface SegmentMeta { id: number; name: string; color: string }`, the Task 6 validator fills it).
- Produces:
  ```ts
  export type Layer = { class: number } | { segment: number }
  export type Vis = (i: number) => boolean
  export const ALL: Vis
  export const SEGMENT_PALETTE: string[]                       // 12 × '#rrggbb'
  export const classOf = (q: Uint32Array, i: number) => number  // (w1 >>> 24)
  export function classCounts(q: Uint32Array, n: number): Record<number, number>
  export function countSegments(seg: Uint8Array, flags: Uint8Array, n: number): Uint32Array   // 256 entries, DELETED excluded
  export function freeSegmentId(used: Iterable<number>): number | null                          // lowest free 1..255
  export function claimSegment(seg: Uint8Array, flags: Uint8Array, n: number, id: number, side: SplitSide, vis: Vis): { range: Range | null; count: number }
  export function releaseSegment(seg: Uint8Array, n: number, id: number): Range | null
  export function layerMember(layer: Layer, q: Uint32Array, seg: Uint8Array): (i: number) => boolean
  export function selectLayer(flags: Uint8Array, n: number, member: (i: number) => boolean, mode: SelectMode, vis: Vis): Range | null
  export function applySegmentBytes(dst: Uint8Array, src: Uint8Array, table: SegmentMeta[]): { segments: Segment[]; unknown: number }
  ```
- `ops.ts`: `isolate(b, side, vis = ALL)`, `hide(b, side, vis = ALL)`, `del(b, side, vis = ALL)` — a subject must also pass `vis(i)`.

- [ ] **Step 1: Write the failing tests**

`src/viewer/edit/layers.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { packWords } from '../format/quant'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { ALL, applySegmentBytes, claimSegment, classCounts, classOf, countSegments, freeSegmentId, layerMember, releaseSegment, selectLayer, SEGMENT_PALETTE } from './layers'

// 8 points: classes 2,2,2,2,6,6,6,7
const CLS = [2, 2, 2, 2, 6, 6, 6, 7]
function words() {
  const q = new Uint32Array(16)
  CLS.forEach((c, i) => { const [a, b] = packWords(i, i, i, c << 8); q[i * 2] = a; q[i * 2 + 1] = b })
  return q
}
describe('layers byte ops', () => {
  it('classOf / classCounts read the packed class byte and skip absent classes', () => {
    const q = words()
    expect(classOf(q, 7)).toBe(7)
    expect(classCounts(q, 8)).toEqual({ 2: 4, 6: 3, 7: 1 })
    expect(classCounts(q, 4)).toEqual({ 2: 4 })
  })
  it('claimSegment tags subject points (selected ∧ side ∧ vis) and reports range + count', () => {
    const seg = new Uint8Array(8), flags = new Uint8Array([S, S | A, S | B, 0, S, H, S, 0])
    const r = claimSegment(seg, flags, 8, 3, 'all', ALL)
    expect(r).toEqual({ range: { min: 0, max: 6 }, count: 5 })
    expect(Array.from(seg)).toEqual([3, 3, 3, 0, 3, 0, 3, 0])
    const r2 = claimSegment(seg, flags, 8, 4, 'A', ALL)       // side filter: only byte 1
    expect(r2).toEqual({ range: { min: 1, max: 1 }, count: 1 })
    expect(seg[1]).toBe(4)                                       // exclusive: moved from 3 to 4
    const r3 = claimSegment(seg, flags, 8, 5, 'all', (i) => i >= 6)
    expect(r3).toEqual({ range: { min: 6, max: 6 }, count: 1 })
    expect(claimSegment(seg, new Uint8Array(8), 8, 6, 'all', ALL)).toEqual({ range: null, count: 0 })
  })
  it('releaseSegment zeroes one id and returns its span', () => {
    const seg = new Uint8Array([0, 2, 1, 2, 0, 2, 0, 0])
    expect(releaseSegment(seg, 8, 2)).toEqual({ min: 1, max: 5 })
    expect(Array.from(seg)).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(releaseSegment(seg, 8, 9)).toBeNull()
  })
  it('countSegments counts live (non-deleted) points per id', () => {
    const seg = new Uint8Array([1, 1, 2, 0, 2, 2, 255, 0]), flags = new Uint8Array([0, D, 0, 0, H, 0, 0, 0])
    const c = countSegments(seg, flags, 8)
    expect(c[1]).toBe(1); expect(c[2]).toBe(3); expect(c[255]).toBe(1); expect(c[0]).toBe(0)
  })
  it('freeSegmentId reuses the lowest gap and returns null at 255', () => {
    expect(freeSegmentId([])).toBe(1)
    expect(freeSegmentId([1, 2, 4])).toBe(3)
    expect(freeSegmentId(Array.from({ length: 255 }, (_, k) => k + 1))).toBeNull()
  })
  it('selectLayer replace/add/subtract on visible members only, split tags dropped with the selection', () => {
    const q = words(), seg = new Uint8Array([0, 0, 0, 0, 9, 9, 0, 0])
    const flags = new Uint8Array([S | A, 0, H, 0, S | B, 0, 0, D])
    const vis = (i: number) => (flags[i] & (H | D)) === 0
    expect(selectLayer(flags, 8, layerMember({ class: 2 }, q, seg), 'replace', vis)).toEqual({ min: 0, max: 4 })
    expect(Array.from(flags)).toEqual([S, S, H, S, 0, 0, 0, D])          // byte 2 hidden: never selected; byte 4 lost S+B
    expect(selectLayer(flags, 8, layerMember({ segment: 9 }, q, seg), 'add', vis)).toEqual({ min: 4, max: 5 })
    expect(flags[4]).toBe(S); expect(flags[5]).toBe(S)
    flags[0] = S | A
    expect(selectLayer(flags, 8, layerMember({ class: 2 }, q, seg), 'subtract', vis)).toEqual({ min: 0, max: 3 })
    expect(Array.from(flags)).toEqual([0, 0, H, 0, S, S, 0, D])
    expect(selectLayer(flags, 8, layerMember({ class: 7 }, q, seg), 'add', vis)).toBeNull()   // the only class-7 point is deleted
  })
  it('applySegmentBytes copies known ids, zeroes unknown ones, counts, and keeps count-0 rows', () => {
    const dst = new Uint8Array(8), src = new Uint8Array([1, 1, 0, 3, 3, 3, 7, 0])
    const r = applySegmentBytes(dst, src, [{ id: 1, name: 'a', color: '#ff0000' }, { id: 3, name: 'b', color: '#00ff00' }, { id: 5, name: 'c', color: '#0000ff' }])
    expect(Array.from(dst)).toEqual([1, 1, 0, 3, 3, 3, 0, 0])
    expect(r.unknown).toBe(1)
    expect(r.segments).toEqual([
      { id: 1, name: 'a', color: '#ff0000', count: 2, visible: true },
      { id: 3, name: 'b', color: '#00ff00', count: 3, visible: true },
      { id: 5, name: 'c', color: '#0000ff', count: 0, visible: true },
    ])
  })
  it('palette has 12 distinct #rrggbb entries', () => {
    expect(SEGMENT_PALETTE).toHaveLength(12)
    expect(new Set(SEGMENT_PALETTE).size).toBe(12)
    SEGMENT_PALETTE.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/viewer/edit/layers.test.ts`
Expected: FAIL — cannot resolve `./layers`.

- [ ] **Step 3: `SegmentMeta` in `loader/manifest.ts`; `Vis`/`ALL` and the visibility predicate in `edit/ops.ts`**

Right after `ManifestChunk` in `loader/manifest.ts`:
```ts
export interface SegmentMeta { id: number; name: string; color: string }   // one exported/imported segment row (#rrggbb)
```
(The `Manifest` fields and validation come in Task 6.)

In `edit/ops.ts`, after `SEL_BITS` (defined here, not in `layers.ts`, because `layers.ts` imports `isSubject` from this file):
```ts
export type Vis = (i: number) => boolean          // extra per-point visibility (layer masks); identity when nothing is masked
export const ALL: Vis = () => true
```
and change the three subject ops:
```ts
export const isolate = (b: Uint8Array, side: SplitSide, vis: Vis = ALL) => whole(b, (f, i) => (isSubject(f, side) && vis(i)) || (f & FLAG_DELETED) ? f : f | FLAG_HIDDEN)
export const hide = (b: Uint8Array, side: SplitSide, vis: Vis = ALL) => whole(b, (f, i) => isSubject(f, side) && vis(i) ? (f & ~SEL_BITS) | FLAG_HIDDEN : f)
export const del = (b: Uint8Array, side: SplitSide, vis: Vis = ALL) => whole(b, (f, i) => isSubject(f, side) && vis(i) ? (f & ~SEL_BITS) | FLAG_DELETED : f)
```

- [ ] **Step 4: Write `edit/layers.ts`**

```ts
import { FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B, type Range } from './flags'
import { isSubject, type Vis } from './ops'
import type { SegmentMeta } from '../loader/manifest'
import type { Segment, SelectMode, SplitSide } from '../state/store'
import { SEG_MAX } from '../render/layerMasks'

export { ALL, type Vis } from './ops'

// Pure byte ops for layers: the segId mirror (`seg`, one byte per point, 0 = none) and the flags mirror.
export type Layer = { class: number } | { segment: number }

export const SEGMENT_PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff']
const SEL_BITS = FLAG_SELECTED | FLAG_SPLIT_A | FLAG_SPLIT_B

export const classOf = (q: Uint32Array, i: number) => q[i * 2 + 1] >>> 24

export function classCounts(q: Uint32Array, n: number): Record<number, number> {
  const counts = new Uint32Array(256)
  for (let i = 0; i < n; i++) counts[q[i * 2 + 1] >>> 24]++
  const out: Record<number, number> = {}
  for (let c = 0; c < 256; c++) if (counts[c] > 0) out[c] = counts[c]
  return out
}

// Live count per id: points carrying it that are not deleted (hidden ones count).
export function countSegments(seg: Uint8Array, flags: Uint8Array, n: number): Uint32Array {
  const counts = new Uint32Array(256)
  for (let i = 0; i < n; i++) { const s = seg[i]; if (s !== 0 && !(flags[i] & FLAG_DELETED)) counts[s]++ }
  return counts
}

export function freeSegmentId(used: Iterable<number>): number | null {
  const taken = new Set(used)
  for (let id = 1; id <= SEG_MAX; id++) if (!taken.has(id)) return id
  return null
}

// Every subject point (selected ∧ side ∧ vis) takes `id`, leaving whatever segment it had (exclusive membership).
export function claimSegment(seg: Uint8Array, flags: Uint8Array, n: number, id: number, side: SplitSide, vis: Vis): { range: Range | null; count: number } {
  let min = -1, max = -1, count = 0
  for (let i = 0; i < n; i++) {
    if (!isSubject(flags[i], side) || !vis(i)) continue
    seg[i] = id; count++
    if (min < 0) min = i
    max = i
  }
  return { range: min < 0 ? null : { min, max }, count }
}

export function releaseSegment(seg: Uint8Array, n: number, id: number): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < n; i++) if (seg[i] === id) { seg[i] = 0; if (min < 0) min = i; max = i }
  return min < 0 ? null : { min, max }
}

export function layerMember(layer: Layer, q: Uint32Array, seg: Uint8Array): (i: number) => boolean {
  return 'class' in layer ? (i) => classOf(q, i) === layer.class : (i) => seg[i] === layer.segment
}

// Like a lasso over the layer: replace clears every selection bit first; add ORs; subtract clears (split tags go with it).
// Only visible members (`vis`: not hidden/deleted and layer-visible) are touched.
export function selectLayer(flags: Uint8Array, n: number, member: (i: number) => boolean, mode: SelectMode, vis: Vis): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < n; i++) {
    const f = flags[i]
    let g = mode === 'replace' ? f & ~SEL_BITS : f
    if (vis(i) && member(i)) g = mode === 'subtract' ? g & ~SEL_BITS : g | FLAG_SELECTED
    if (g !== f) { flags[i] = g; if (min < 0) min = i; max = i }
  }
  return min < 0 ? null : { min, max }
}

// Import: copy `src` (one byte per point, from segments.bin) into the mirror, dropping ids the table doesn't list.
export function applySegmentBytes(dst: Uint8Array, src: Uint8Array, table: SegmentMeta[]): { segments: Segment[]; unknown: number } {
  const known = new Uint8Array(256)
  for (const s of table) known[s.id] = 1
  const counts = new Uint32Array(256)
  let unknown = 0
  for (let i = 0; i < src.length; i++) {
    const s = src[i]
    if (s !== 0 && !known[s]) { unknown++; dst[i] = 0; continue }
    dst[i] = s; counts[s]++
  }
  return { segments: table.map((s) => ({ id: s.id, name: s.name, color: s.color, count: counts[s.id], visible: true })), unknown }
}
```
- [ ] **Step 5: Run the layer and ops tests**

Run: `npx vitest run src/viewer/edit`
Expected: PASS (existing `ops.test.ts` unchanged: the default `vis` is the identity).

- [ ] **Step 6: Commit**

```bash
git add src/viewer/edit/layers.ts src/viewer/edit/layers.test.ts src/viewer/edit/ops.ts src/viewer/loader/manifest.ts
git commit -m "layers: pure byte ops (class counts, claim/release, selectLayer, segment import), vis predicate on subject ops"
```

---

### Task 3: Editor layer methods

**Files:**
- Modify: `src/viewer/edit/editor.ts`, `src/viewer/edit/editor.test.ts`

**Interfaces:**
- Consumes: Task 1 `buffers.segBytes / uploadSegRange / masks`, `patchLayers`, `Segment`; Task 2 `edit/layers.ts` ops and `ALL`/`Vis`; `setBit / classBit / isVisible / allVisible / fillVisible` from `render/layerMasks.ts`.
- Produces on `Editor`:
  ```ts
  segBytes: Uint8Array                                   // = buffers.segBytes
  saveSegment(name?: string): Segment | null             // outside the undo ring; null = nothing to claim / 255 ids used
  deleteSegment(id: number): void
  renameSegment(id: number, name: string): void
  setSegmentColor(id: number, color: string): void       // '#rrggbb'
  setLayerVisible(layer: Layer, visible: boolean): void
  soloLayer(layer: Layer): void
  showAllLayers(): void
  selectLayer(layer: Layer, mode: SelectMode): void      // through the undo ring (whole-buffer push)
  ```

- [ ] **Step 1: Write the failing editor tests**

Append to `src/viewer/edit/editor.test.ts` (imports: add `packWords` is already there; add `import { SEGMENT_PALETTE } from './layers'`). Add a second fixture whose points carry classes, then the tests:
```ts
// Same geometry, classes 2,2,2,2,6,6,6,7 in the packed byte.
function setupClassed() {
  const buffers = createPointBuffers(8, 1)
  const q = buffers.qpos.array as Uint32Array
  const cls = [2, 2, 2, 2, 6, 6, 6, 7]
  for (let i = 0; i < 8; i++) { const [a, b] = packWords(i * 8000, (i * 13000) % 30000, i % 2 ? 33422 : 32112, cls[i] << 8); q[i * 2] = a; q[i * 2 + 1] = b }
  const store = createStore(initialState)
  store.set({ status: 'ready' })
  return { buffers, store, editor: createEditor(buffers, manifest, store) }
}
describe('editor layers', () => {
  it('selectLayer goes through the undo ring like a lasso', () => {
    const { store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace')
    expect(store.get().edit.counts.selected).toBe(3)
    expect(store.get().edit.undoDepth).toBe(1)
    editor.selectLayer({ class: 7 }, 'add')
    expect(store.get().edit.counts.selected).toBe(4)
    editor.undo()
    expect(store.get().edit.counts.selected).toBe(3)
    editor.undo()
    expect(store.get().edit.counts.selected).toBe(0)
    expect(store.get().edit.redoDepth).toBe(2)
  })
  it('a masked layer is not selectable and its selected points are not op subjects', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 2 }, 'replace')
    editor.setLayerVisible({ class: 2 }, false)
    expect(buffers.masks.words[0]).toBe((0xffffffff & ~(1 << 2)) >>> 0)
    expect(buffers.masks.attr.version).toBe(1)
    expect(store.get().layers.classVisible[2]).toBe(false)
    editor.hide()                                   // subjects are selected ∧ visible → none
    expect(store.get().edit.counts.hidden).toBe(0)
    expect(store.get().edit.undoDepth).toBe(1)      // no-op left no entry
    editor.selectLayer({ class: 2 }, 'add')         // no visible members → no-op, no entry
    expect(store.get().edit.undoDepth).toBe(1)
    editor.setLayerVisible({ class: 2 }, true)
    editor.hide()
    expect(store.get().edit.counts.hidden).toBe(4)
  })
  it('saveSegment claims the selection outside the undo ring; del reduces its count; undo restores it', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace')
    const s = editor.saveSegment()
    expect(s).toEqual({ id: 1, name: 'Segment 1', color: SEGMENT_PALETTE[0], count: 3, visible: true })
    expect(Array.from(editor.segBytes.subarray(0, 8))).toEqual([0, 0, 0, 0, 1, 1, 1, 0])
    expect(buffers.segIds.updateRanges.at(-1)).toEqual({ start: 1, count: 1 })
    expect(store.get().layers.segments).toEqual([s])
    expect(store.get().edit.undoDepth).toBe(1)      // still just the selectLayer
    editor.pick(4, 'replace'); editor.del()
    expect(store.get().layers.segments[0].count).toBe(2)
    editor.undo()
    expect(store.get().layers.segments[0].count).toBe(3)
    const s2 = editor.saveSegment()                  // undo restored point 4's SELECTED bit, so it moves to a new segment
    expect(s2?.id).toBe(2); expect(s2?.count).toBe(1)
    expect(store.get().layers.segments[0].count).toBe(2)
  })
  it('saveSegment with nothing selected returns null; custom name; exclusive membership moves points', () => {
    const { store, editor } = setupClassed()
    expect(editor.saveSegment()).toBeNull()
    editor.selectLayer({ class: 2 }, 'replace')
    expect(editor.saveSegment('roof')?.name).toBe('roof')
    editor.pick(0, 'replace'); editor.pick(4, 'add')
    const s2 = editor.saveSegment()
    expect(s2?.id).toBe(2); expect(s2?.count).toBe(2)
    expect(store.get().layers.segments.map((s) => s.count)).toEqual([3, 2])   // byte 0 moved from 1 to 2
  })
  it('deleteSegment returns its points to unsegmented and a reused id starts visible', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace'); editor.saveSegment()
    editor.setLayerVisible({ segment: 1 }, false)
    expect(store.get().layers.segments[0].visible).toBe(false)
    expect(buffers.masks.words[1]).toBe((0xffffffff & ~(1 << 1)) >>> 0)
    editor.deleteSegment(1)
    expect(store.get().layers.segments).toEqual([])
    expect(Array.from(editor.segBytes.subarray(0, 8)).every((v) => v === 0)).toBe(true)
    expect(buffers.masks.words[1]).toBe(0xffffffff)
    editor.selectLayer({ class: 7 }, 'replace')
    const s = editor.saveSegment()
    expect(s?.id).toBe(1); expect(s?.visible).toBe(true); expect(s?.count).toBe(1)
  })
  it('rename and recolour patch the row; solo and show-all rewrite the masks', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace'); editor.saveSegment()
    editor.renameSegment(1, 'north wall'); editor.setSegmentColor(1, '#123456')
    expect(store.get().layers.segments[0]).toMatchObject({ name: 'north wall', color: '#123456' })
    editor.soloLayer({ segment: 1 })
    expect(buffers.masks.words[0]).toBe(0xffffffff)
    expect(buffers.masks.words[1]).toBe(1 << 1)
    expect(buffers.masks.words[8]).toBe(0)
    editor.soloLayer({ class: 6 })
    expect(buffers.masks.words[0]).toBe(1 << 6)
    expect(buffers.masks.words[1]).toBe(0xffffffff)
    expect(store.get().layers.classVisible).toEqual({ 6: true })   // solo writes every listed class; none are listed before ready (Task 6)
    editor.showAllLayers()
    expect(Array.from(buffers.masks.words).every((w) => w === 0xffffffff)).toBe(true)
    expect(store.get().layers.segments[0].visible).toBe(true)
  })
})
```
- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/viewer/edit/editor.test.ts`
Expected: FAIL — `editor.selectLayer is not a function`.

- [ ] **Step 3: Implement in `edit/editor.ts`**

Imports:
```ts
import { patchEdit, patchLayers, type SelectMode, type Segment, type Store, type ViewerState } from '../state/store'
import { allVisible, classBit, fillVisible, isVisible, setBit } from '../render/layerMasks'
import { ALL, claimSegment, countSegments, freeSegmentId, layerMember, releaseSegment, selectLayer as selectLayerBytes, SEGMENT_PALETTE, type Layer, type Vis } from './layers'
```
`Editor` interface additions (after `refresh`):
```ts
  segBytes: Uint8Array                                 // = buffers.segBytes
  // Layers. Segment table edits and visibility are outside the undo ring; selectLayer goes through it (whole-buffer push).
  saveSegment(name?: string): Segment | null
  deleteSegment(id: number): void
  renameSegment(id: number, name: string): void
  setSegmentColor(id: number, color: string): void
  setLayerVisible(layer: Layer, visible: boolean): void
  soloLayer(layer: Layer): void
  showAllLayers(): void
  selectLayer(layer: Layer, mode: SelectMode): void
```
Inside `createEditor`, after `const q = …`:
```ts
  const seg = buffers.segBytes
  const masks = buffers.masks
  const layers = () => store.get().layers
  // Layer visibility of point i (class bit ∧ segment bit); identity while nothing is masked so unmasked ops keep phase 5's cost.
  const layerOk = (i: number) => isVisible(masks.words, q[i * 2 + 1] >>> 24, seg[i])
  const maskVis = (): Vis => allVisible(masks.words) ? ALL : layerOk
  const visible = (i: number) => (bytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && layerOk(i)
```
(add `FLAG_HIDDEN, FLAG_DELETED` to the `./flags` import). Extend `refresh` — after the `patch({...})` line:
```ts
    const segs = layers().segments
    if (segs.length > 0) {
      const c = countSegments(seg, bytes, N)
      if (segs.some((s) => s.count !== c[s.id])) patchLayers(store, { segments: segs.map((s) => s.count === c[s.id] ? s : { ...s, count: c[s.id] }) })
    }
```
Change the three ops and `selectedPositions`:
```ts
    isolate: () => run(all, () => ops.isolate(bytes, side(), maskVis())),
    hide: () => run(all, () => ops.hide(bytes, side(), maskVis())),
    del: () => run(all, () => ops.del(bytes, side(), maskVis())),
```
```ts
  const selectedPositions = () => {
    const vis = maskVis()
    let n = 0
    for (let i = 0; i < N; i++) if ((bytes[i] & FLAG_SELECTED) && vis(i)) n++
    const pts = new Float32Array(n * 3)
    for (let i = 0, k = 0; i < N; i++) if ((bytes[i] & FLAG_SELECTED) && vis(i)) { decodeScaled(i, pts, k); k += 3 }
    return { pts, n }
  }
```
Mask helpers (before the `return {`):
```ts
  const segWord = (id: number) => 1 + (id >> 5)
  const setMaskSegment = (id: number, on: boolean) => setBit(masks.words, segWord(id), id & 31, on)
  const setMaskClass = (cls: number, on: boolean) => setBit(masks.words, 0, classBit(cls), on)
  const patchSegment = (id: number, p: Partial<Segment>) => patchLayers(store, { segments: layers().segments.map((s) => s.id === id ? { ...s, ...p } : s) })
  const classVisibleAll = (on: boolean) => Object.fromEntries(Object.keys(layers().classCounts).map((c) => [c, on])) as Record<number, boolean>
```
Methods in the returned object:
```ts
    segBytes: seg,
    saveSegment(name) {
      if (!ready()) return null
      const segs = layers().segments
      const id = freeSegmentId(segs.map((s) => s.id))
      if (id === null) { patch({ message: 'All 255 segment ids are in use.' }); return null }
      const r = claimSegment(seg, bytes, N, id, side(), maskVis())
      if (!r.range) return null
      buffers.uploadSegRange(r.range.min, r.range.max)
      setMaskSegment(id, true); masks.upload()          // a reused id starts visible
      const s: Segment = { id, name: name ?? `Segment ${id}`, color: SEGMENT_PALETTE[(id - 1) % SEGMENT_PALETTE.length], count: r.count, visible: true }
      patchLayers(store, { segments: [...segs, s] })
      refresh()                                          // recounts segments that lost points to this one
      return s
    },
    deleteSegment(id) {
      if (!ready()) return
      const r = releaseSegment(seg, N, id)
      if (r) buffers.uploadSegRange(r.min, r.max)
      setMaskSegment(id, true); masks.upload()
      patchLayers(store, { segments: layers().segments.filter((s) => s.id !== id) })
    },
    renameSegment(id, name) { patchSegment(id, { name }) },
    setSegmentColor(id, color) { patchSegment(id, { color }) },
    setLayerVisible(layer, on) {
      if ('class' in layer) { setMaskClass(layer.class, on); patchLayers(store, { classVisible: { ...layers().classVisible, [layer.class]: on } }) }
      else { setMaskSegment(layer.segment, on); patchSegment(layer.segment, { visible: on }) }
      masks.upload()
    },
    soloLayer(layer) {
      fillVisible(masks.words)
      if ('class' in layer) {
        masks.words[0] = 0; setMaskClass(layer.class, true)
        patchLayers(store, { classVisible: { ...classVisibleAll(false), [layer.class]: true }, segments: layers().segments.map((s) => s.visible ? s : { ...s, visible: true }) })
      } else {
        masks.words.fill(0, 1); setMaskSegment(layer.segment, true)
        patchLayers(store, { classVisible: classVisibleAll(true), segments: layers().segments.map((s) => ({ ...s, visible: s.id === layer.segment })) })
      }
      masks.upload()
    },
    showAllLayers() {
      fillVisible(masks.words); masks.upload()
      patchLayers(store, { classVisible: classVisibleAll(true), segments: layers().segments.map((s) => s.visible ? s : { ...s, visible: true }) })
    },
    selectLayer(layer, mode) { run(all, () => selectLayerBytes(bytes, N, layerMember(layer, q, seg), mode, visible)) },
```

- [ ] **Step 4: Run the editor tests**

Run: `npx vitest run src/viewer/edit/editor.test.ts`
Expected: PASS. If the "solo" expectation on `classVisible` fails because `classCounts` is empty before Task 6, the expected value is `{ 6: true }` exactly as written (the spread of an empty map plus the solo class).

- [ ] **Step 5: tsc + full vitest, commit**

Run: `npx tsc --noEmit && npx vitest run`
```bash
git add src/viewer/edit/editor.ts src/viewer/edit/editor.test.ts
git commit -m "editor: segment save/delete/rename/colour, layer visibility + solo, selectLayer through undo, masked points are not op subjects"
```

---

### Task 4: Vertex stage masks, `segments` colour mode, segment LUT

**Files:**
- Modify: `src/viewer/render/colormaps.ts`, `src/viewer/render/colormaps.test.ts`, `src/viewer/render/pointMaterial.ts`, `src/viewer/render/ChunkSprites.tsx`, `src/viewer/ui/Panel.tsx`

**Interfaces:**
- Consumes: `buffers.segIdsNode`, `buffers.masks.node` (Task 1); `store.layers.segments` (Task 3 writes colours).
- Produces (`render/colormaps.ts`): `ASPRS_NAMES: Record<number, string>`, `SEGMENT_NONE = '#8a8a8a'`, `hexToRgb(hex: string): [number, number, number]` (bytes), `LutKind` gains `'segments'`; `buildLut('segments')` = 256 × `SEGMENT_NONE`.
- Produces (`render/pointMaterial.ts`): `PointMaterialHandle.setSegmentColor(id: number, color: string): void`; `export const lutKindFor = (mode: ColorMode, colormap: Colormap): LutKind`.

- [ ] **Step 1: Failing colormap tests**

Append to `src/viewer/render/colormaps.test.ts`:
```ts
import { ASPRS_NAMES, SEGMENT_NONE, buildLut, hexToRgb } from './colormaps'

describe('segment LUT and class names', () => {
  it('hexToRgb parses #rrggbb into bytes', () => {
    expect(hexToRgb('#8a8a8a')).toEqual([138, 138, 138])
    expect(hexToRgb('#FF0080')).toEqual([255, 0, 128])
  })
  it('the segments LUT starts as 256 entries of the unsegmented grey', () => {
    const lut = buildLut('segments')
    const [r, g, b] = hexToRgb(SEGMENT_NONE)
    for (let i = 0; i < 256; i++) expect(Array.from(lut.subarray(i * 4, i * 4 + 4))).toEqual([r, g, b, 255])
  })
  it('ASPRS names cover the classes the colour table lists', () => {
    for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 9, 17, 18]) expect(typeof ASPRS_NAMES[k]).toBe('string')
    expect(ASPRS_NAMES[6]).toBe('Building')
  })
})
```
(merge the import with the file's existing one from `./colormaps`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/viewer/render/colormaps.test.ts` — FAIL on the missing exports.

- [ ] **Step 3: Extend `render/colormaps.ts`**

After `ASPRS_COLORS`:
```ts
// ASPRS LAS 1.4 standard class names; the Layers card prefers the manifest's classMap, then this, then "Class N".
export const ASPRS_NAMES: Record<number, string> = {
  0: 'Never classified', 1: 'Unclassified', 2: 'Ground', 3: 'Low vegetation', 4: 'Medium vegetation', 5: 'High vegetation',
  6: 'Building', 7: 'Low noise', 8: 'Reserved', 9: 'Water', 10: 'Rail', 11: 'Road surface', 12: 'Reserved',
  13: 'Wire – guard', 14: 'Wire – conductor', 15: 'Transmission tower', 16: 'Wire connector', 17: 'Bridge deck', 18: 'High noise',
}

export const SEGMENT_NONE = '#8a8a8a'   // unsegmented points in the Segments colour mode (LUT entry 0)
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export type LutKind = 'viridis' | 'turbo' | 'grayscale' | 'class' | 'segments'
```
(remove the old `LutKind` line). In `buildLut`, add a branch before the `class` one:
```ts
    if (kind === 'segments') {
      const c = hexToRgb(SEGMENT_NONE)
      rgb = [c[0] / 255, c[1] / 255, c[2] / 255]
    } else if (kind === 'class') {
```

- [ ] **Step 4: Run colormap tests** — `npx vitest run src/viewer/render/colormaps.test.ts` → PASS.

- [ ] **Step 5: Vertex stage in `render/pointMaterial.ts`**

Imports: add `min` to the `three/tsl` import (not imported today), `hexToRgb` to the `./colormaps` import and `Colormap` to the store type import. `MODE` already has `segments: 3` (Task 1 Step 11). Add after the `MODE`/`SHADING` constants:
```ts
export const lutKindFor = (mode: ColorMode, colormap: Colormap): LutKind => mode === 'class' || mode === 'segments' ? mode : colormap
```
`PointMaterialHandle` gains:
```ts
  setSegmentColor(id: number, color: string): void   // '#rrggbb' → segments LUT entry; entry 0 stays SEGMENT_NONE
```
After `const tint = …` add the reads (all in the vertex stage, same `byteOf` unpack as flags):
```ts
  // Layer masks (render/layerMasks.ts): word 0 class bit, words 1..8 segment bit. Both 0/1 → one multiply on the size term,
  // so a masked point collapses exactly like a hidden one (A8) and no branch touches positionView.
  const sbyte = byteOf(buffers.segIdsNode)
  const mw = buffers.masks.node
  const clsBit = mw.element(uint(0)).shiftRight(min(cls, uint(31))).bitAnd(uint(1))
  const segBit = mw.element(sbyte.shiftRight(uint(5)).add(uint(1))).shiftRight(sbyte.bitAnd(uint(31))).bitAnd(uint(1))
  const layerVisible = float(clsBit.mul(segBit))
```
Change the size line:
```ts
  material.sizeNode = select(collapsed, float(0), sizePx).mul(layerVisible)
```
Colour scalar: add `const tS = float(sbyte).div(255)` next to `tC` and
```ts
  const t = select(mode.equal(1), tI, select(mode.equal(2), tC, select(mode.equal(3), tS, tH)))
```
Initial LUT: `texture(lutFor(lutKindFor(init.colorMode, init.colormap)), …)`. Handle method:
```ts
    setSegmentColor: (id, color) => {
      const tex = lutFor('segments')
      ;(tex.image.data as Uint8Array).set([...hexToRgb(color), 255], id * 4)
      tex.needsUpdate = true
    },
```

- [ ] **Step 6: `ChunkSprites.tsx` and `Panel.tsx`**

`ChunkSprites.tsx`: import `lutKindFor` from `./pointMaterial`; replace the mode/lut effect body with
```ts
  useEffect(() => {
    handle.setMode(colorMode)
    handle.setLut(lutKindFor(colorMode, colormap))
  }, [handle, colorMode, colormap])
  const segments = useStore((s) => s.layers.segments)
  useEffect(() => { segments.forEach((s) => handle.setSegmentColor(s.id, s.color)) }, [handle, segments])
```
`Panel.tsx`: add `<option value="segments">Segments</option>` after Classification, and gate the colormap select with `{colorMode !== 'class' && colorMode !== 'segments' && (`.

- [ ] **Step 7: tsc + vitest + build**

Run: `npx tsc --noEmit && npx vitest run && npm run build` — all green.

- [ ] **Step 8: Browser check (2M)**

Open `http://localhost:5173/point-cloud/app/?data=demo&bench=1` (Playwright MCP). `browser_console_messages` must show 0 errors after load. Then `browser_evaluate`:
```js
async () => { await __pcv.waitFor(() => __pcv.loadedFraction() === 1 && __pcv.state().status === 'ready'); await __pcv.settle(2000); return JSON.stringify(__pcv.frame()) }
```
Record `ms` (expect ≈ 8.3, the vsync floor). Then:
```js
async () => { __pcv.editor.setLayerVisible({ class: 2 }, false); await __pcv.settle(800); return JSON.stringify(__pcv.frame()) }
```
`browser_take_screenshot` → ground gone (streets/parks empty), buildings/trees intact. Then:
```js
async () => { __pcv.editor.showAllLayers(); const f = __pcv.frame(); await __pcv.lasso([[f.width*0.35,f.height*0.35],[f.width*0.65,f.height*0.35],[f.width*0.65,f.height*0.65],[f.width*0.35,f.height*0.65]]); const s = __pcv.editor.saveSegment('centre'); __pcv.colorMode('segments'); await __pcv.settle(800); return JSON.stringify({ s, seg: __pcv.state().layers.segments }) }
```
Screenshot: the lassoed block in palette colour 1 (`#e6194b`), everything else grey. Then `__pcv.editor.soloLayer({ segment: 1 })` + screenshot (only the block), `__pcv.editor.setSegmentColor(1, '#00ffff')` + screenshot (block turns cyan — proves the `needsUpdate` re-upload), `__pcv.editor.deleteSegment(1)` + screenshot (all grey), `__pcv.colorMode('class'); __pcv.editor.showAllLayers()`. Console still 0 errors. Save the screenshots as `.playwright-mcp/p7-hide-ground.png`, `p7-segments-mode.png`, `p7-solo.png`.

- [ ] **Step 9: Commit**

```bash
git add src/viewer/render/colormaps.ts src/viewer/render/colormaps.test.ts src/viewer/render/pointMaterial.ts src/viewer/render/ChunkSprites.tsx src/viewer/ui/Panel.tsx
git commit -m "material: layer masks collapse masked points, segments colour mode over a mutable segment LUT, ASPRS names"
```

---

### Task 5: Select kernels + CPU reference honour the masks

**Files:**
- Modify: `src/viewer/compute/wgsl/select.ts`, `src/viewer/edit/selectPipeline.ts`, `src/viewer/bench/cpuReference.ts`

**Interfaces:**
- Consumes: `buffers.segIdsNode`, `buffers.masks.node/words`, `buffers.segBytes` (Task 1); `api.selectionClasses` slot (Task 1).
- Produces: kernels `pickDepth`, `pickIndex`, `lassoSelect` take two more storage params `segIds`, `masks` (bound once at pipeline creation); `api.cpuLasso`/`api.cpuPick` apply the masks; `api.selectionClasses()` returns `{ [cls]: selectedCount }`.

- [ ] **Step 1: WGSL helper + kernel predicates (`compute/wgsl/select.ts`)**

Append to `selectHelpers`:
```wgsl
// Layer visibility: class bit min(cls, 31) of masks[0], segment bit of masks[1 + seg/32]. Same rule as render/layerMasks.ts isVisible.
fn pcvLayerOk(masks: ptr<storage, array<u32>, read_write>, segIds: ptr<storage, array<u32>, read_write>, w1: u32, i: u32) -> bool {
  let cls = min((w1 >> 24u) & 0xffu, 31u);
  let seg = (segIds[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
  return ((masks[0] >> cls) & 1u) == 1u && ((masks[1u + (seg >> 5u)] >> (seg & 31u)) & 1u) == 1u;
}
```
`pcvPickDepthBits`: add `segIds: ptr<storage, array<u32>, read_write>, masks: ptr<storage, array<u32>, read_write>,` after `flags`, and replace the decode lines with
```wgsl
  let w = qpos[i];
  if (!pcvLayerOk(masks, segIds, w.y, i)) { return 0xffffffffu; }
  let p = pcvDecodePos(w, dqScale) + dqMin;
```
`pickParams`: insert `segIds: ptr<storage, array<u32>, read_write>, masks: ptr<storage, array<u32>, read_write>,` after the `flags` param; `pickArgs`: `qpos, flags, segIds, masks, chunkTable, …`.
`lassoSelect`: add the same two params after `flags`; change the inner test to
```wgsl
      if ((f & 5u) == 0u && i < pcvVisibleEnd(chunkTable, chunks, i) && pcvLayerOk(masks, segIds, qpos[i].y, i)) {
```

- [ ] **Step 2: Bind in `edit/selectPipeline.ts`**

In `common`: `qpos: buffers.qposNode, flags: buffers.flagsNode, segIds: buffers.segIdsNode, masks: buffers.masks.node, chunkTable, …`. Nothing else changes (`ViewParams` unchanged, per spec).

- [ ] **Step 3: CPU reference (`bench/cpuReference.ts`)**

```ts
import { isVisible } from '../render/layerMasks'
```
`visible`:
```ts
    const visible = (i: number) => (buffers.flagBytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && i < end[chunkOf(i)] && isVisible(buffers.masks.words, q[i * 2 + 1] >>> 24, buffers.segBytes[i])
```
Add the bench slot before the disposer:
```ts
  api.selectionClasses = () => {
    const out: Record<number, number> = {}
    for (let i = 0; i < buffers.count; i++) if (buffers.flagBytes[i] & FLAG_SELECTED) { const c = q[i * 2 + 1] >>> 24; out[c] = (out[c] ?? 0) + 1 }
    return out
  }
  return () => { api.cpuPick = undefined; api.cpuLasso = undefined; api.selectionClasses = undefined }
```
(import `FLAG_SELECTED` from `../edit/flags`). Update the file's header comment: "same visibility rule (not hidden/deleted, inside the chunk's budget prefix, **layer-visible**)".

- [ ] **Step 4: tsc + build** — `npx tsc --noEmit && npm run build` green.

- [ ] **Step 5: Browser check — acceptance criterion 1 (2M)**

Reload `?data=demo&bench=1`, wait ready + settle 2 s, 0 console errors (a WGSL compile error would show here as a `GPUValidationError`). Then:
```js
async () => {
  for (const c of [1, 2, 3, 5, 7]) __pcv.editor.setLayerVisible({ class: c }, false)   // leave class 6 (building) only
  await __pcv.settle(300)
  const f = __pcv.frame()
  const poly = [[f.width*0.3,f.height*0.3],[f.width*0.7,f.height*0.3],[f.width*0.7,f.height*0.7],[f.width*0.3,f.height*0.7]]
  const l = await __pcv.lasso(poly)
  const cpu = __pcv.cpuLasso(poly)
  const classes = __pcv.selectionClasses()
  const p = await __pcv.pick(f.width/2, f.height/2, 'add'), cp = __pcv.cpuPick(f.width/2, f.height/2)
  return JSON.stringify({ l, cpu, classes, pickMs: p.ms, cpuPick: cp })
}
```
Expect `l.selected === cpu`, `Object.keys(classes)` = `["6"]`, `l.selected > 0`. Then `__pcv.editor.showAllLayers(); __pcv.editor.clearSelection()` and repeat the lasso with everything visible: `selected === cpu` again and several classes present. Record both numbers for ARCHITECTURE. `browser_take_screenshot` → `.playwright-mcp/p7-lasso-building-only.png` (building points tinted, nothing else selected).

- [ ] **Step 6: Commit**

```bash
git add src/viewer/compute/wgsl/select.ts src/viewer/edit/selectPipeline.ts src/viewer/bench/cpuReference.ts
git commit -m "select kernels + CPU reference: skip layer-masked points; selectionClasses bench slot"
```

---

### Task 6: Export / import of segments, class counts at `ready`

**Files:**
- Modify: `src/viewer/loader/manifest.ts`, `src/viewer/loader/manifest.test.ts`, `src/viewer/edit/export.ts`, `src/viewer/edit/export.test.ts`, `src/viewer/loader/fetchChunks.ts` (`LoaderIn`), `src/viewer/loader/loader.worker.ts`, `src/viewer/loader/useLoader.ts`

**Interfaces:**
- Consumes: `SegmentMeta` (Task 2), `classCounts`, `applySegmentBytes` (Task 2), `buffers.segBytes/uploadSegRange` (Task 1), `store.layers.segments` (Task 3).
- Produces:
  ```ts
  // manifest.ts
  Manifest.segments?: SegmentMeta[]; Manifest.segmentsFile?: string
  fetchManifest(url, fetchFn?) → { manifest; binUrl; segmentsUrl: string | null }
  // export.ts
  compactPoints(words, flags, n, seg?: Uint8Array) → { words; count; qmin; qmax; seg: Uint8Array | null }
  exportManifest(src, count, qmin, qmax, segments: SegmentMeta[] = []) → Manifest   // adds segments + segmentsFile when non-empty
  buildZip(words, manifest, seg?: Uint8Array | null) → Uint8Array                    // adds segments.bin when manifest.segmentsFile && seg
  // fetchChunks.ts
  LoaderIn 'export': { words; flags; seg: Uint8Array; segments: SegmentMeta[]; manifest }
  ```

- [ ] **Step 1: Failing manifest tests**

Append to `describe('validateManifest', …)` in `src/viewer/loader/manifest.test.ts`:
```ts
  it('leaves segments/segmentsFile absent when the manifest has none', () => {
    const m = validateManifest(good)
    expect('segments' in m).toBe(false); expect('segmentsFile' in m).toBe(false)
  })
  it('accepts the optional segments table and file, lower-casing colours', () => {
    const m = validateManifest({ ...good, segments: [{ id: 1, name: 'roof', color: '#FF0000' }, { id: 255, name: 'x', color: '#00ff00' }], segmentsFile: 'segments.bin' })
    expect(m.segments).toEqual([{ id: 1, name: 'roof', color: '#ff0000' }, { id: 255, name: 'x', color: '#00ff00' }])
    expect(m.segmentsFile).toBe('segments.bin')
  })
  it('rejects a segment id outside 1..255, a bad colour, a duplicate id, a non-string segmentsFile', () => {
    const seg = (s: object) => ({ ...good, segments: [s] })
    expect(() => validateManifest(seg({ id: 0, name: 'a', color: '#000000' }))).toThrow(/segment/)
    expect(() => validateManifest(seg({ id: 256, name: 'a', color: '#000000' }))).toThrow(/segment/)
    expect(() => validateManifest(seg({ id: 1.5, name: 'a', color: '#000000' }))).toThrow(/segment/)
    expect(() => validateManifest(seg({ id: 1, name: 'a', color: 'red' }))).toThrow(/segment/)
    expect(() => validateManifest(seg({ id: 1, color: '#000000' }))).toThrow(/segment/)
    expect(() => validateManifest({ ...good, segments: [{ id: 1, name: 'a', color: '#000000' }, { id: 1, name: 'b', color: '#000000' }] })).toThrow(/duplicate/)
    expect(() => validateManifest({ ...good, segments: {} })).toThrow(/segments/)
    expect(() => validateManifest({ ...good, segmentsFile: 3 })).toThrow(/segmentsFile/)
  })
```
And in `describe('fetchManifest', …)` (see the existing test for the fake `fetch` shape) add:
```ts
  it('resolves segmentsUrl next to the manifest, null without segmentsFile', async () => {
    const fake = (body: object) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
    const a = await fetchManifest('https://x.test/data/e/manifest.json', fake({ ...good, segments: [{ id: 1, name: 'a', color: '#000000' }], segmentsFile: 'segments.bin' }))
    expect(a.segmentsUrl).toBe('https://x.test/data/e/segments.bin')
    const b = await fetchManifest('https://x.test/data/e/manifest.json', fake(good))
    expect(b.segmentsUrl).toBeNull()
  })
```

- [ ] **Step 2: Run** — `npx vitest run src/viewer/loader/manifest.test.ts` → FAIL (fields ignored / `segmentsUrl` undefined).

- [ ] **Step 3: Implement in `loader/manifest.ts`**

`Manifest` gains, after `chunks`:
```ts
  segments?: SegmentMeta[]     // phase 7 export: user segments (ids 1..255), optional
  segmentsFile?: string        // one byte per point, same order as `file`; optional
```
In `validateManifest`, after the chunk loop:
```ts
  const HEX = /^#[0-9a-f]{6}$/i
  let segments: SegmentMeta[] | undefined
  if (m.segments !== undefined) {
    if (!Array.isArray(m.segments)) throw new Error('manifest: segments must be an array')
    const seen = new Set<number>()
    segments = (m.segments as SegmentMeta[]).map((s) => {
      if (typeof s !== 'object' || s === null || !Number.isInteger(s.id) || s.id < 1 || s.id > 255 || typeof s.name !== 'string' || typeof s.color !== 'string' || !HEX.test(s.color)) throw new Error('manifest: segment invalid')
      if (seen.has(s.id)) throw new Error(`manifest: duplicate segment id ${s.id}`)
      seen.add(s.id)
      return { id: s.id, name: s.name, color: s.color.toLowerCase() }
    })
  }
  if (m.segmentsFile !== undefined && typeof m.segmentsFile !== 'string') throw new Error('manifest: segmentsFile must be a string')
```
and in the returned object:
```ts
    ...(segments && { segments }),
    ...(typeof m.segmentsFile === 'string' && { segmentsFile: m.segmentsFile }),
```
`fetchManifest`:
```ts
export async function fetchManifest(url: string, fetchFn: typeof fetch = fetch): Promise<{ manifest: Manifest; binUrl: string; segmentsUrl: string | null }> {
  …
  return { manifest, binUrl: resolveBinUrl(absolute, manifest.file), segmentsUrl: manifest.segmentsFile ? resolveBinUrl(absolute, manifest.segmentsFile) : null }
}
```

- [ ] **Step 4: Run** — manifest tests PASS.

- [ ] **Step 5: Failing export tests**

Append to `src/viewer/edit/export.test.ts` (imports: add `applySegmentBytes` from `./layers`):
```ts
  it('compactPoints compacts segment bytes alongside the words', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, FLAG_HIDDEN, 0]), seg = new Uint8Array([1, 1, 0, 2])
    const r = compactPoints(words(), flags, 4, seg)
    expect(r.count).toBe(3)
    expect(Array.from(r.seg!)).toEqual([1, 0, 2])
    expect(compactPoints(words(), flags, 4).seg).toBeNull()
  })
  it('exportManifest with segments adds the table + segmentsFile; without them the keys are absent', () => {
    const table = [{ id: 1, name: 'roof', color: '#e6194b' }]
    const m = exportManifest(src, 3, [0, 0, 0], [65535, 65535, 65535], table)
    expect(m.segments).toEqual(table); expect(m.segmentsFile).toBe('segments.bin')
    const plain = exportManifest(src, 3, [0, 0, 0], [65535, 65535, 65535])
    expect('segments' in plain).toBe(false); expect('segmentsFile' in plain).toBe(false)
    expect(JSON.stringify(plain)).not.toContain('segments')
  })
  it('zip carries segments.bin only when the manifest names it', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, 0, 0]), seg = new Uint8Array([1, 1, 0, 2])
    const r = compactPoints(words(), flags, 4, seg)
    const m = exportManifest(src, r.count, r.qmin, r.qmax, [{ id: 1, name: 'a', color: '#000000' }, { id: 2, name: 'b', color: '#ffffff' }])
    const files = unzipSync(buildZip(r.words, m, r.seg))
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'points.bin', 'segments.bin'])
    expect(Array.from(files['segments.bin'])).toEqual([1, 0, 2])
    const plain = unzipSync(buildZip(r.words, exportManifest(src, r.count, r.qmin, r.qmax), r.seg))
    expect(Object.keys(plain).sort()).toEqual(['manifest.json', 'points.bin'])
  })
  it('round trip: manifest validates, segments.bin re-imports with counts; a count-0 segment survives', () => {
    const flags = new Uint8Array([0, 0, FLAG_DELETED, 0]), seg = new Uint8Array([1, 1, 3, 0])
    const r = compactPoints(words(), flags, 4, seg)
    const table = [{ id: 1, name: 'a', color: '#e6194b' }, { id: 3, name: 'gone', color: '#3cb44b' }]
    const files = unzipSync(buildZip(r.words, exportManifest(src, r.count, r.qmin, r.qmax, table), r.seg))
    const m = validateManifest(JSON.parse(strFromU8(files['manifest.json'])))
    expect(m.segmentsFile).toBe('segments.bin')
    const dst = new Uint8Array(m.pointCount)
    const imported = applySegmentBytes(dst, files['segments.bin'], m.segments!)
    expect(imported.unknown).toBe(0)
    expect(imported.segments.map((s) => [s.id, s.count])).toEqual([[1, 2], [3, 0]])
  })
```

- [ ] **Step 6: Run** — `npx vitest run src/viewer/edit/export.test.ts` → FAIL.

- [ ] **Step 7: Implement in `edit/export.ts`**

```ts
import type { Manifest, SegmentMeta } from '../loader/manifest'
```
```ts
export function compactPoints(words: Uint32Array, flags: Uint8Array, n: number, seg?: Uint8Array): { words: Uint32Array; count: number; qmin: V3; qmax: V3; seg: Uint8Array | null } {
  let count = 0
  for (let i = 0; i < n; i++) if (!(flags[i] & FLAG_DELETED)) count++
  const out = new Uint32Array(count * WORDS_PER_POINT)
  const segOut = seg ? new Uint8Array(count) : null
  const qmin: V3 = [65535, 65535, 65535], qmax: V3 = [0, 0, 0]
  let k = 0
  for (let i = 0; i < n; i++) {
    if (flags[i] & FLAG_DELETED) continue
    if (segOut) segOut[k >> 1] = seg![i]
    const w0 = words[i * 2], w1 = words[i * 2 + 1]
    out[k++] = w0; out[k++] = w1
    …(bounds unchanged)
  }
  if (count === 0) { qmin[0] = qmin[1] = qmin[2] = 0 }
  return { words: out, count, qmin, qmax, seg: segOut }
}

export const SEGMENTS_FILE = 'segments.bin'
export function exportManifest(src: Manifest, count: number, qmin: V3, qmax: V3, segments: SegmentMeta[] = []): Manifest {
  const dq = …
  return {
    version: 1, …, chunks: [{ offset: 0, count, bounds: { min: dq(qmin), max: dq(qmax) } }],
    ...(segments.length > 0 && { segments: segments.map(({ id, name, color }) => ({ id, name, color })), segmentsFile: SEGMENTS_FILE }),
  }
}

export function buildZip(words: Uint32Array, manifest: Manifest, seg?: Uint8Array | null): Uint8Array {
  return zipSync({
    'points.bin': [new Uint8Array(words.buffer, words.byteOffset, words.byteLength), { level: 0 }],
    ...(manifest.segmentsFile && seg && { [manifest.segmentsFile]: [seg, { level: 0 }] as [Uint8Array, { level: 0 }] }),
    'manifest.json': strToU8(JSON.stringify(manifest, null, 1)),
  })
}
```
(`segOut[k >> 1]`: `k` counts words, two per point, so `k >> 1` is the output point index **before** the two `out[k++]` writes.)

- [ ] **Step 8: Run** — export tests PASS.

- [ ] **Step 9: Worker message and handler**

`loader/fetchChunks.ts`:
```ts
import type { Manifest, SegmentMeta } from './manifest'
  | { type: 'export'; words: Uint32Array; flags: Uint8Array; seg: Uint8Array; segments: SegmentMeta[]; manifest: Manifest }
```
`loader/loader.worker.ts` export branch:
```ts
      const r = compactPoints(msg.words, msg.flags, msg.words.length / WORDS_PER_POINT, msg.segments.length > 0 ? msg.seg : undefined)
      const zip = buildZip(r.words, exportManifest(msg.manifest, r.count, r.qmin, r.qmax, msg.segments), r.seg)
```

- [ ] **Step 10: `useLoader.ts` — send segments on export, count classes and import segments before `ready`**

Imports:
```ts
import { applySegmentBytes, classCounts } from '../edit/layers'
import type { Segment } from '../state/store'
```
`Loaded` gains `segmentsUrl: string | null`; the first effect's `.then(({ manifest, binUrl, segmentsUrl }) => …)` passes it into `setLoaded({ manifest, binUrl, segmentsUrl, buffers, handle, editor })`. In the worker effect destructure `const { manifest, binUrl, buffers, segmentsUrl } = loaded`, add `let disposed = false` next to `let points = 0`, and replace the `done` branch:
```ts
      } else if (msg.type === 'done') {
        void finish()
```
with, defined above `worker.onmessage`:
```ts
    // Class counts once (one pass over the words, ~30 ms at 20M) and the exported segment table, both before `ready` so the
    // Layers card never shows zeros. A missing/short segments.bin only costs the segments (warned), never the dataset.
    const finish = async () => {
      const counts = classCounts(buffers.qpos.array as Uint32Array, manifest.pointCount)
      const classVisible: Record<number, boolean> = {}
      for (const c of Object.keys(counts)) classVisible[Number(c)] = true
      let segments: Segment[] = []
      if (segmentsUrl && manifest.segments && manifest.segments.length > 0) {
        try {
          const res = await fetch(segmentsUrl)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const bytes = new Uint8Array(await res.arrayBuffer())
          if (bytes.length !== manifest.pointCount) throw new Error(`${bytes.length} bytes for ${manifest.pointCount} points`)
          const r = applySegmentBytes(buffers.segBytes, bytes, manifest.segments)
          if (r.unknown > 0) console.warn(`segments: dropped ${r.unknown} points whose id is not in the manifest table`)
          buffers.uploadSegRange(0, manifest.pointCount - 1)
          segments = r.segments
        } catch (err) { console.warn(`segments: ${String(err)} (${segmentsUrl}); opening without segments`) }
      }
      if (disposed) return
      store.set({ layers: { classCounts: counts, classVisible, segments }, status: 'ready', loadMs: performance.now() - t0 })
      api.sendCamera = undefined
    }
```
`exportZip` message:
```ts
        const segments = store.get().layers.segments.map(({ id, name, color }) => ({ id, name, color }))
        const m: LoaderIn = { type: 'export', words: (buffers.qpos.array as Uint32Array).slice(), flags: buffers.flagBytes.slice(), seg: buffers.segBytes.slice(), segments, manifest }
        worker.postMessage(m, [m.words.buffer, m.flags.buffer, m.seg.buffer])
```
In the cleanup add `disposed = true` first.

- [ ] **Step 11: tsc + vitest + build** — all green.

- [ ] **Step 12: Browser check — acceptance criterion 3 (2M)**

Reload `?data=demo&bench=1`, wait ready. Check the class rows exist in state: `JSON.stringify(__pcv.state().layers.classCounts)` → `{1:…,2:…,3:…,5:…,6:…,7:…}` summing to 2,000,000 (verify the sum in the evaluate). Then create two segments and export:
```js
async () => { const f = __pcv.frame(); await __pcv.lasso([[f.width*0.2,f.height*0.2],[f.width*0.45,f.height*0.2],[f.width*0.45,f.height*0.45],[f.width*0.2,f.height*0.45]]); const a = __pcv.editor.saveSegment('north'); await __pcv.lasso([[f.width*0.55,f.height*0.55],[f.width*0.8,f.height*0.55],[f.width*0.8,f.height*0.8],[f.width*0.55,f.height*0.8]]); const b = __pcv.editor.saveSegment('south'); __pcv.editor.clearSelection(); return JSON.stringify([a, b]) }
```
Record both counts and colours. Click the toolbar **Export** button (`browser_click`), wait for `edit.message` to read `exported 2,000,000 points`; the zip lands in `.playwright-mcp/export.zip`. Then in the shell:
```bash
rm -rf public/data/export-seg && mkdir -p public/data/export-seg && unzip -o .playwright-mcp/export.zip -d public/data/export-seg && ls -l public/data/export-seg && python3 -c "import json;m=json.load(open('public/data/export-seg/manifest.json'));print(m['segments'],m['segmentsFile'],m['pointCount'])"
```
Expect `segments.bin` of exactly `pointCount` bytes and the two rows. Open `?data=export-seg&bench=1`, wait ready: `JSON.stringify(__pcv.state().layers.segments)` shows both rows with the **same counts and colours**; `__pcv.colorMode('segments')` + screenshot `.playwright-mcp/p7-reopen-segments.png` (two coloured blocks). Negative path: `mv public/data/export-seg/segments.bin /tmp/` then reload — dataset reaches `ready`, `segments` is `[]`, console has one `segments: HTTP 404` warning and 0 errors; move the file back. A plain export (no segments) from `?data=demo` must produce a manifest without the two keys: repeat Export with no segments, `unzip -l` shows two files, `grep -c segments manifest.json` → 0.

- [ ] **Step 13: Commit**

```bash
git add src/viewer/loader/manifest.ts src/viewer/loader/manifest.test.ts src/viewer/edit/export.ts src/viewer/edit/export.test.ts src/viewer/loader/fetchChunks.ts src/viewer/loader/loader.worker.ts src/viewer/loader/useLoader.ts
git commit -m "export/import segments: segments.bin + manifest table, optional fields validated, class counts + segment import before ready"
```

---

### Task 7: Layers card UI

**Files:**
- Create: `src/viewer/ui/LayersPanel.tsx`, `src/viewer/ui/LayersPanel.module.css`
- Modify: `src/viewer/PointCloudViewer.tsx`, `src/viewer/PointCloudViewer.module.css`, `src/viewer/ui/Panel.module.css`, `src/viewer/ui/Overlays.tsx` (key list unchanged — verify only)

**Interfaces:**
- Consumes: `Editor` layer methods (Task 3), `store.layers` (Task 1/6), `ASPRS_COLORS`/`ASPRS_NAMES` (Task 4), `modeFromEvent` (`ui/keys.ts`), `Layer` type (Task 2).
- Produces: `export function LayersPanel({ editor }: { editor: Editor | null })`.

- [ ] **Step 1: Layout column**

`src/viewer/PointCloudViewer.module.css` add:
```css
/* Right-hand column for the cards; the column itself is transparent to the pointer so the canvas under its empty part still picks. */
.side { position: absolute; top: 8px; right: 8px; bottom: 8px; z-index: 2; width: 244px; display: grid; gap: 8px; align-content: start; overflow-y: auto; pointer-events: none; }
.side > * { pointer-events: auto; }
```
`src/viewer/ui/Panel.module.css` `.panel`: remove `position: absolute; top: 8px; right: 8px; z-index: 2; width: 220px;` (keep the rest). `PointCloudViewer.tsx`:
```tsx
      <div className={styles.side}>
        <Panel api={api} />
        <LayersPanel editor={loaded?.editor ?? null} />
      </div>
```
(import `LayersPanel` from `./ui/LayersPanel`).

- [ ] **Step 2: `ui/LayersPanel.module.css`**

```css
.card { padding: 10px 12px; background: var(--pcv-card); color: var(--pcv-text); border: 1px solid var(--pcv-border); border-radius: var(--pcv-radius); font: 12px/1.5 var(--pcv-font); display: grid; gap: 3px; }
.header { display: flex; justify-content: space-between; align-items: center; background: none; border: 0; padding: 0; color: var(--pcv-text); font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
.header span { color: var(--pcv-muted); font-weight: 400; }
.groupTitle { color: var(--pcv-text-2); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; font-size: 10px; padding-top: 6px; }
.row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto 16px; gap: 6px; align-items: center; padding: 1px 3px; border-radius: 4px; cursor: pointer; user-select: none; }
.row:hover { background: var(--pcv-surface); }
.row[data-hidden=true] { opacity: 0.45; }
.segRow { grid-template-columns: 12px minmax(0, 1fr) auto 16px 16px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--pcv-border); position: relative; overflow: hidden; }
.swatch input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nameInput { min-width: 0; width: 100%; background: none; border: 0; border-bottom: 1px solid transparent; color: var(--pcv-text); font: inherit; padding: 0; cursor: text; }
.nameInput:focus { outline: none; border-bottom-color: var(--pcv-accent); }
.count { color: var(--pcv-muted); font: 11px/1.4 var(--pcv-mono); }
.icon { background: none; border: 0; padding: 0; color: var(--pcv-text-2); font: inherit; line-height: 1; cursor: pointer; }
.icon:hover { color: var(--pcv-text); }
.icon:disabled { opacity: 0.4; cursor: default; }
.footer { display: grid; gap: 4px; padding-top: 6px; }
.button { padding: 4px 8px; background: var(--pcv-surface); color: var(--pcv-text); border: 1px solid var(--pcv-border); border-radius: 4px; font: inherit; cursor: pointer; }
.button:disabled { opacity: 0.5; cursor: default; }
.muted { color: var(--pcv-muted); }
```

- [ ] **Step 3: `ui/LayersPanel.tsx`**

```tsx
import { useState, type MouseEvent, type SyntheticEvent } from 'react'
import { useStore, type Segment } from '../state/store'
import type { Editor } from '../edit/editor'
import type { Layer } from '../edit/layers'
import { ASPRS_COLORS, ASPRS_NAMES } from '../render/colormaps'
import { modeFromEvent } from './keys'
import styles from './LayersPanel.module.css'

// Row click → selectLayer (⇧ add, ⌥ subtract), double-click → solo, eye → visibility. Buttons prevent mousedown so focus
// (and the key map) stays on the viewer root; the name/colour inputs keep default focus and stop the row handlers.
const stop = (e: SyntheticEvent) => e.stopPropagation()
const keepFocus = (e: MouseEvent) => e.preventDefault()

export function LayersPanel({ editor }: { editor: Editor | null }) {
  const manifest = useStore((s) => s.manifest)
  const layers = useStore((s) => s.layers)
  const selected = useStore((s) => s.edit.counts.selected)
  const busy = useStore((s) => s.edit.busy)
  const status = useStore((s) => s.status)
  const [open, setOpen] = useState(true)
  const ready = status === 'ready' && !!editor && !busy
  const classes = Object.keys(layers.classCounts).map(Number).sort((a, b) => a - b)
  const className = (c: number) => manifest?.classMap[String(c)] ?? ASPRS_NAMES[c] ?? `Class ${c}`
  const classRgb = (c: number) => { const [r, g, b] = ASPRS_COLORS[c] ?? ASPRS_COLORS[-1]; return `rgb(${r}, ${g}, ${b})` }
  const select = (layer: Layer) => (e: MouseEvent) => { if (editor && ready) editor.selectLayer(layer, modeFromEvent(e)) }
  const solo = (layer: Layer) => () => editor?.soloLayer(layer)
  const toggle = (layer: Layer, visible: boolean) => (e: MouseEvent) => { stop(e); editor?.setLayerVisible(layer, !visible) }
  return (
    <div className={styles.card}>
      <button className={styles.header} onMouseDown={keepFocus} onClick={() => setOpen((o) => !o)}>Layers <span>{open ? '−' : '+'}</span></button>
      {open && (
        <>
          <div className={styles.groupTitle}>Classes</div>
          {classes.length === 0 && <div className={styles.muted}>Counted when the load finishes.</div>}
          {classes.map((c) => {
            const visible = layers.classVisible[c] !== false
            return (
              <div key={c} className={styles.row} data-hidden={!visible} onMouseDown={keepFocus} onClick={select({ class: c })} onDoubleClick={solo({ class: c })} title="click: select · ⇧ add · ⌥ subtract · double-click: solo">
                <span className={styles.swatch} style={{ background: classRgb(c) }} />
                <span className={styles.name}>{className(c)}</span>
                <span className={styles.count}>{layers.classCounts[c].toLocaleString()}</span>
                <button className={styles.icon} title={visible ? 'Hide' : 'Show'} onMouseDown={keepFocus} onClick={toggle({ class: c }, visible)} onDoubleClick={stop}>{visible ? '●' : '○'}</button>
              </div>
            )
          })}
          <div className={styles.groupTitle}>Segments</div>
          {layers.segments.length === 0 && <div className={styles.muted}>Select points, then save them as a segment.</div>}
          {layers.segments.map((s) => (
            <SegmentRow key={s.id} s={s} editor={editor} ready={ready} onSelect={select({ segment: s.id })} onSolo={solo({ segment: s.id })} onToggle={toggle({ segment: s.id }, s.visible)} />
          ))}
          <div className={styles.footer}>
            <button className={styles.button} disabled={!ready || selected === 0} onMouseDown={keepFocus} onClick={() => editor?.saveSegment()}>Save selection as segment</button>
            <button className={styles.button} disabled={!editor} onMouseDown={keepFocus} onClick={() => editor?.showAllLayers()}>Show all</button>
          </div>
        </>
      )}
    </div>
  )
}

function SegmentRow({ s, editor, ready, onSelect, onSolo, onToggle }: {
  s: Segment; editor: Editor | null; ready: boolean; onSelect: (e: MouseEvent) => void; onSolo: () => void; onToggle: (e: MouseEvent) => void
}) {
  return (
    <div className={`${styles.row} ${styles.segRow}`} data-hidden={!s.visible} onMouseDown={keepFocus} onClick={onSelect} onDoubleClick={onSolo} title="click: select · ⇧ add · ⌥ subtract · double-click: solo">
      <label className={styles.swatch} style={{ background: s.color }} onMouseDown={stop} onClick={stop} onDoubleClick={stop} title="Colour">
        <input type="color" value={s.color} onChange={(e) => editor?.setSegmentColor(s.id, e.target.value)} />
      </label>
      <input className={styles.nameInput} value={s.name} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onChange={(e) => editor?.renameSegment(s.id, e.target.value)} title="Rename" />
      <span className={styles.count}>{s.count.toLocaleString()}</span>
      <button className={styles.icon} title={s.visible ? 'Hide' : 'Show'} onMouseDown={keepFocus} onClick={onToggle} onDoubleClick={stop}>{s.visible ? '●' : '○'}</button>
      <button className={styles.icon} title="Delete segment" disabled={!ready} onMouseDown={keepFocus} onClick={(e) => { stop(e); editor?.deleteSegment(s.id) }} onDoubleClick={stop}>×</button>
    </div>
  )
}
```
Note: the root's `onKeyDown` already returns early for `INPUT` targets, so typing a segment name (or `Delete` inside it) never fires an op; `type="color"` is also an `INPUT`.

- [ ] **Step 4: tsc + vitest + build** — all green.

- [ ] **Step 5: Browser check (2M) and screenshots**

Reload `?data=demo&bench=1`, wait ready. `browser_snapshot`: the Layers card lists Classes rows `Unclassified · Ground · Low Vegetation · High Vegetation · Building · Low Point (Noise)` (the manifest's `classMap` names) with counts, an empty Segments hint, and the two footer buttons (Save disabled). Interactions, each followed by a state read:
1. `browser_click` the **Building** row → `__pcv.state().edit.counts.selected` equals `layers.classCounts[6]`; undoDepth 1. Screenshot `.playwright-mcp/p7-layers-select-building.png`.
2. Shift-click **Ground** (`browser_click` with `modifiers: ['Shift']`) → selected = building + ground.
3. Click the Ground eye → `classVisible[2] === false`, row dimmed, ground gone from the canvas.
4. Click **Save selection as segment** → a `Segment 1` row whose count equals `classCounts[6]` only: the ground points are still flagged selected, but ruling 6 makes a masked point not a subject, so `claimSegment` skips them. Confirm `segments[0].count === layers.classCounts[6]` in the state.
5. Double-click the segment row → solo: every class row dimmed except… (segment solo leaves classes visible and hides unsegmented points) → screenshot `.playwright-mcp/p7-layers-solo.png`.
6. Type in the name input (`browser_type` "roof block") → `segments[0].name`; press `Delete` inside the input → nothing deleted (`counts.deleted` 0).
7. Click **Show all**, click × on the segment → rows back to none, canvas back to full.
8. `document.activeElement` after step 1 and after step 4 is the viewer root (buttons prevent mousedown): `browser_evaluate` `() => document.activeElement?.getAttribute('tabindex')` → `"0"`.
Console 0 errors throughout. Also resize to 1280×720 and screenshot the whole viewer at colour mode Segments with two segments for README (`docs/media/layers.png`, added in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/viewer/ui/LayersPanel.tsx src/viewer/ui/LayersPanel.module.css src/viewer/PointCloudViewer.tsx src/viewer/PointCloudViewer.module.css src/viewer/ui/Panel.module.css
git commit -m "ui: Layers card (classes + segments, visibility, select/solo, save/rename/recolour/delete) in a right-hand column"
```

---

### Task 8: 2M / 20M verification, docs, gates

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` (phase list), `scripts/bench.md`, `docs/media/layers.png` (new screenshot)

- [ ] **Step 1: 20M checks (`?data=full&bench=1`, fresh tab, other tabs closed)**

One evaluate, in-page (no external polling while 160 MB streams):
```js
async () => {
  await __pcv.waitFor(() => __pcv.loadedFraction() === 1 && __pcv.state().status === 'ready', 300000); await __pcv.settle(3000)
  const out = { loadMs: __pcv.loadMs(), classCounts: __pcv.state().layers.classCounts, frameAll: __pcv.frame() }
  for (const c of Object.keys(out.classCounts).map(Number)) if (c !== 6) __pcv.editor.setLayerVisible({ class: c }, false)
  await __pcv.settle(1500); out.frameBuildingOnly = __pcv.frame()
  const f = out.frameAll
  const poly = [[f.width*0.3,f.height*0.3],[f.width*0.7,f.height*0.3],[f.width*0.7,f.height*0.7],[f.width*0.3,f.height*0.7]]
  const t0 = performance.now(); out.lasso = await __pcv.lasso(poly); out.lassoWallMs = performance.now() - t0
  out.cpuSelected = __pcv.cpuLasso(poly); out.classes = __pcv.selectionClasses()
  const t1 = performance.now(); out.segment = __pcv.editor.saveSegment('roofs'); out.saveMs = performance.now() - t1
  __pcv.colorMode('segments'); await __pcv.settle(1500); out.frameSegments = __pcv.frame()
  __pcv.editor.soloLayer({ segment: 1 }); await __pcv.settle(1500); out.frameSolo = __pcv.frame()
  __pcv.editor.showAllLayers(); __pcv.colorMode('height')
  const t2 = performance.now(); __pcv.editor.selectLayer({ class: 2 }, 'replace'); out.selectLayerMs = performance.now() - t2
  out.selectedGround = __pcv.state().edit.counts.selected; out.undoDepth = __pcv.state().edit.undoDepth
  const t3 = performance.now(); __pcv.editor.undo(); out.undoMs = performance.now() - t3
  const t4 = performance.now(); __pcv.editor.deleteSegment(1); out.deleteSegMs = performance.now() - t4
  await __pcv.settle(1500); out.frameEnd = __pcv.frame()
  return JSON.stringify(out)
}
```
Acceptance: `lasso.selected === cpuSelected`; `Object.keys(classes)` = `["6"]`; `frameAll.ms` within ±1 ms of phase 6's 33.19 ms; `frameBuildingOnly.ms < frameAll.ms`; `frameSegments.ms` ≈ `frameAll.ms`; `classCounts` sums to 20,000,000; `selectedGround === classCounts[2]`; `undoDepth` counts the lasso + selectLayer. Record every number. Then Export at 20M via the toolbar (busy span from `edit.message`), `unzip -l` the zip: three files, `segments.bin` = `pointCount` bytes; do **not** re-open 20M (phase 5 precedent).

- [ ] **Step 2: 2M row for the README**

Repeat the same evaluate on `?data=demo&bench=1` (expect 8.3 ms in every frame state — vsync floor). Save the Task 7 screenshot as `docs/media/layers.png` (1280×720, DPR 1, Segments colour mode, two segments, Layers card open).

- [ ] **Step 3: README**

Controls table: add rows
```
| layers card (right, below the panel) | Classes: one row per class present (swatch, name, count, eye); Segments: your saved selections (colour, name, count, eye, ×). Click a row → select it (`⇧` add, `⌥` subtract), double-click → solo, eye → hide/show, Show all. Hidden layers are skipped by pick, lasso and every op |
```
and change the panel row's colour mode list to `(height / intensity / class / segments)`. After `### Export` add:
```
### Layers
Every class the tile carries is a row; a segment is a named group of points you save from the current selection (one `segId` byte per point, exclusive, ≤ 255 segments). Class and segment visibility are two independent masks read by the vertex stage and the select kernels, so hiding ground and vegetation and lassoing a roof selects the building alone. Segment save / rename / recolour / delete are outside the undo ring; selecting a layer goes through it like a lasso. Export writes `segments.bin` + a `segments` table into the manifest (optional fields; a plain export is unchanged) and re-open restores the rows; visibility is not persisted. The Segments colour mode paints each segment with its colour and everything else grey.
```
Architecture bullets: extend **Rendering** with "one `segId` byte per point and a 9-word layer mask drive per-layer visibility (masked quads collapse) and the Segments colour mode" and **Editing** with "Layers: class rows, saved segments, masks honoured by the kernels and the CPU ops; segments export/import". Performance section: add a short **Layers (phase 7)** table with the measured 2M/20M rows (frame all-visible / building-only / segments mode, lasso selected = cpu, `selectLayer` ms, `saveSegment` ms, `deleteSegment` ms, export size with `segments.bin`) and the `layers.png` image. Memory line (if the README lists the 20M GPU budget): +20 MB `segIds`, ≈414 MB after a build.

- [ ] **Step 4: ARCHITECTURE**

Add `## Layers (phase 7)` after `## Bench and deploy (phase 6)` with subsections: **Buffers and masks** (`segIds` packing = flags, `segBytes` mirror, `uploadSegRange`; `layerMasks.ts` 9 words, bit rules incl. class ≥ 31 → bit 31, `masks.upload()` whole 36 B), **Vertex stage** (`clsBit × segBit` multiplied into `sizeNode`; segments LUT = mutable 256×1 sRGB `DataTexture`, entry 0 grey — ruling 2; `t` select gains mode 3), **Kernels** (`pcvLayerOk`, bound once; CPU reference identical), **Editor** (`maskVis()` identity when unmasked; `refresh()` recount — ruling 3; undo boundaries), **Export/import** (`segments.bin`, manifest fields, `applySegmentBytes`, `ready` after import — ruling 4), **UI** (column layout, focus rule, key handling in inputs), **Measured** (the Task 8 tables, 2M and 20M, with the phase 6 frame row for comparison, lasso vs `cpuLasso` equality with building-only masks, export zip sizes), and the Task 4–7 screenshot names. Update `## Overview`'s memory line (+20 MB `segIds` at 20M). Deferred: add a **Layers (Phase 7)** block: automatic instances (connected components) parked — a `segId` per point and the list model are in place; class ≥ 31 mask sharing; `refresh()` recount is a 20M pass whenever segments exist (fold into `scanFlags` if it shows); layer visibility not persisted; segment colour input is the browser's native picker. Mark the phase 5 Deferred "toolbar overlaps the Panel below ≈860 px" entry as changed by the scroll column if the browser check shows it (re-measure at 1277×804).

- [ ] **Step 5: Master spec, runbook**

`docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` § 7 list: add `7. **layers** — class/segment rows, visibility masks in the vertex stage + kernels, segments save/export/import, Segments colour mode. **Done.**`; Status line stays `complete` with the date bumped. `scripts/bench.md`: add a **Layers** line pointing at the Task 8 Step 1 evaluate (keys `frameAll`, `frameBuildingOnly`, `lasso`, `cpuSelected`, `classes`, `saveMs`, `selectLayerMs`).

- [ ] **Step 6: Gates and grep checks**

```bash
npx tsc --noEmit && npx vitest run && npm run build && tools/.venv/bin/pytest tools/tests -q
grep -rn "window\.\|import.meta.env.DEV\|location\." src/viewer | grep -v "globalThis.location" ; echo "(expect no output above)"
```
Expected: all green; the grep prints nothing (the `globalThis.location?.href` in `manifest.ts` is pre-existing and excluded).

- [ ] **Step 7: Commit docs, push branch**

```bash
git add README.md docs/ARCHITECTURE.md docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md scripts/bench.md docs/media/layers.png
git commit -m "docs: layers card, segments export, phase 7 numbers"
git push -u origin phase-7-layers
```
Then the whole-branch review, `git checkout main && git merge --no-ff phase-7-layers -m "merge phase-7-layers"`, `git push origin main`, `git branch -d phase-7-layers`, `git push origin --delete phase-7-layers`, confirm the Vercel deploy at `https://point-cloud-editor.vercel.app/point-cloud/app/?data=demo` shows the Layers card, then `/deslop` over the phase's changed files and push again.

---

## Self-review

- **Spec coverage**: buffers + `LayerMasks` (T1), vertex stage + colour mode (T4), kernels + CPU reference (T5), store (T1, T6 fills counts), editor ops incl. `visibleIndex`-equivalent `maskVis`/`visible` and count maintenance (T2–T3), UI (T7), export/import + `validateManifest` (T6), acceptance criteria 1–6 (T5 S5, T4 S8, T6 S12, T8 S1, T3 tests, T8 S6), tests list (T1–T6), docs (T8). `ViewParams` unchanged (T5). Keys unchanged. `EMBEDDING.md` unchanged (no new props).
- **Deviations** are the numbered Rulings above; the spec's `segColors` storage buffer (ruling 2), `visibleIndex(i)` name (`visible`/`maskVis` in the editor), and per-`del` decrement (ruling 3) are the only ones.
- **Type consistency**: `Layer` (`edit/layers.ts`) used by editor + UI; `Segment` (store) returned by `saveSegment` and produced by `applySegmentBytes`; `SegmentMeta` (manifest) consumed by export, worker message and `applySegmentBytes`; `Vis`/`ALL` defined in `ops.ts`, re-exported from `layers.ts`; `LutKind 'segments'` in colormaps + `lutKindFor` in pointMaterial; `MemoryRow.segIds`; `api.selectionClasses` on `ViewerApi`.
- **Review Focus** tests: 1 → T1 `layerMasks.test.ts`; 2 → T3 "reused id starts visible"; 3 → T3 "del reduces … undo restores"; 4 → T2 `applySegmentBytes` + T6 S12 negative path; 5 → T6 "count-0 segment survives".
