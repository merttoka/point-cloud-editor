# Phase 5: Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select points by click or lasso on the GPU, apply flag edits (isolate / hide / delete / split / unhide / clear) with byte-exact undo/redo, colour selected and split points in the vertex stage, and export the surviving points as a re-openable dataset zip.

**Architecture:** The CPU source of truth for per-point flags is a `Uint8Array` view over the existing `flags` storage attribute's backing buffer (`PointBuffers.flagBytes`); every CPU edit mutates bytes then uploads one word-aligned range (`uploadFlagsRange`). `edit/editor.ts` glues the pure modules (`ops`, `undo`, `plane`, `lasso`, `project`) to the buffers and the store. GPU selection is two raw-WGSL kernel families in `compute/wgsl/select.ts` (pick = `atomicMin` on depth bits then index; lasso = thread-per-word even-odd polygon test) owned by `edit/selectPipeline.ts` and mounted inside `<Canvas>` by `edit/EditRunner.tsx`, which exposes `api.pick` / `api.lasso` and disables `OrbitControls` in lasso mode. After a lasso the whole flags buffer is read back into the mirror (A5). The material tints selected / splitA / splitB points with a branchless vertex-stage blend. Export runs in the loader worker (`compactPoints` + `fflate.zipSync`). UI: `ui/Toolbar.tsx` (tool, ops, undo/redo, split side, export) and `ui/LassoOverlay.tsx` (SVG polygon over the canvas); shortcuts stay on the viewer root.

**Tech Stack:** three 0.186.0 (`three/webgpu`, `three/tsl`: `wgslFn`, `storage().toAtomic()`, `uniform(Matrix4)`, `computeAsync`, `getArrayBufferAsync`), R3F 9.7.0, drei 10.7.8 (`OrbitControls makeDefault`), React 19.3.0, `fflate@0.8.3` (new, approved), vitest (node), Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-5-editing-design.md` (parent §4, amendments A2, A5, A6, A8, A9). Drift notes: `docs/superpowers/specs/2026-09-17-spec-review-phases-3-6.md` § Phase 5 (items 1–10).

## Rulings on the spec-review items (Phase 5 §1–10) and further drift

| # | Ruling |
|---|---|
| 1 Flags mirror | `PointBuffers.flagBytes = new Uint8Array(flags.array.buffer)` (byte *i* = point *i*, little-endian, same bytes the vertex stage unpacks). `uploadFlagsRange(minIdx, maxIdx)` = `flags.addUpdateRange(minIdx >> 2, (maxIdx >> 2) - (minIdx >> 2) + 1)` + `needsUpdate = true`. Undo slices copy from the view. |
| 2 Keys | `H` stays HUD. Editing keys: `L` lasso tool, `Esc` cancel lasso / back to orbit, `I` isolate, `X` hide, `Delete`/`Backspace` delete, `U` unhide all, `C` clear selection, `S` split, `Cmd/Ctrl+Z` undo, `Shift+Cmd/Ctrl+Z` redo. |
| 3 Pick radius | Attenuated: kernel computes `sizePx = clamp(pointSize × refDist / −viewZ, 1, 8)` exactly as the material and uses `r = max(3, sizePx)` (px). `refDist = homePose(manifest, camera.fov).dist` (what `CameraRig.fit` sets) — computed in `EditRunner`, no plumbing. |
| 4 Dequant + viewProj | Kernels take `dqScale`, `dqMinCentred` (`vec3<f32>`, from `dequantScale(bounds)` and `bounds.min − centroid`) and `viewProj: mat4x4<f32>` = `camera.projectionMatrix × camera.matrixWorldInverse` (WebGPU [0,1] depth; sprites have identity model matrix). Screen px in CSS px from `viewport = (clientWidth, clientHeight)`. |
| 5 Tint | Three flag weights `sel / a / b ∈ {0,1}` from `fbyte` bits (`float(fbyte & bit) / bit`, no `select`), packed in one `vertexStage(vec3(...))`; `colorNode = mix(mix(mix(base, accent, sel × 0.7), colA, a), colB, b)`. Accent read from `--pcv-accent` on the root (fallback `#bf1656`); `colA = #2ec4b6`, `colB = #ff9f1c`. `PointMaterialHandle.setHighlight({ selected, splitA, splitB })`. |
| 6 Lasso vs controls | `EditRunner` subscribes to `edit.tool` and sets `useThree().controls.enabled = tool === 'orbit'` (the `makeDefault` instance). `LassoOverlay` (SVG, sibling of `<Scene>` in the root, `inset: 0`) has `pointer-events: auto` only in lasso mode. |
| 7 Re-open | Fresh page load only: the dev harness accepts `?data=<name>` (`[a-z0-9-]+`, `/data/<name>/manifest.json`); the acceptance test unzips into `public/data/export/`. Dataset switching on a mounted viewer stays in Deferred (owner moves to "any"). |
| 8 Worker | `export` joins `LoaderIn`; `exportDone` / `exportError` join `LoaderOut`. `words` + `flags` transferred (160 + 20 MB at 20M). |
| 9 Readback | `renderer.getArrayBufferAsync(flags)` after the first frame; result copied with `flags.array.set(new Uint32Array(buf))` — **no** `needsUpdate` (GPU already holds it). |
| 10 Scoping | Handlers stay on the root `onKeyDown`; no `activeElement` check. |
| 11 Budget | *New.* Only rendered points are pickable/selectable: kernels get `chunkTable: array<vec2<u32>>` (`x = offset`, `y = offset + ceil(count × budget)`, 256 entries, rewritten before each dispatch) and binary-search the point's chunk; `i ≥ y` → skip. Prevents editing invisible points at < 100 % budget. |
| 12 Layout | `compute/wgsl/select.ts` (Phase 4 folder convention) instead of `compute/select.wgsl.ts`; `edit/selectPipeline.ts` + `edit/EditRunner.tsx` own the GPU side; `edit/editor.ts` owns the CPU side; `edit/project.ts` is the CPU projection reference. |
| 13 Timing | Lasso GPU ms via the existing `timedCompute`; readback ms by `performance.now()`. Stored in `edit.lasso = { gpuMs, readbackMs, selected }`. |
| 14 Plane | `plane.ts` reuses `smallestEigenvector` from `compute/cpu/normals.ts` (no second Jacobi); seeded PRNG (`mulberry32`) for deterministic tests. |
| 15 Pick reset | A `resetPick` kernel (`atomicStore` 0xffffffff, `.compute(2, [1])`) instead of a CPU write + upload — one fewer upload path to trust. |
| 16 Click modes | Plain click = replace (miss → clear selection), Shift = add, Alt = subtract; same three modes as the lasso. Click = pointerdown→up on the canvas with < 4 px movement. |
| 17 Serialisation | `edit.busy` is true while a GPU select or export is in flight; ops, undo/redo and new picks/lassos are ignored meanwhile. |
| 18 Counts | After every edit `countFlags(bytes)` (one pass, ~10 ms at 20M) refreshes `edit.counts = { selected, hidden, deleted }` for the toolbar. |
| 19 Selection range | The editor tracks `selRange = [min, max]` of the current selection so pick-replace and `clearSelection` upload only that range (whole buffer only when the GPU cleared it). |
| 20 Undo for GPU selects | `prevFlags` = full copy of the mirror taken before the dispatch (20 MB at 20M, as the spec expects); pick-replace uses `selRange ∪ {idx}`. |

## Global Constraints

- Pinned deps only; **one new runtime dep: `fflate@0.8.3`** (exact, `save-exact` is on). No leva/zustand.
- WebGPU only. Compute = raw WGSL via `wgslFn` + `storage()` nodes; every kernel returns `u32` and its call is `.toVar()`-ed; never `toReadOnly()`; flags writes are thread-per-word (lasso) — the pick kernels never write flags; `instanceIndex` with an `i ≥ N` guard, `.compute(N, [64])`.
- Hidden/deleted collapse the quad (`sizeNode = 0`). Anything derived from the point index inside `colorNode` goes through `vertexStage()`; vertex-stage mode blends are branchless.
- `src/viewer/` self-contained; CSS modules; `--pcv-*` tokens; keys on the viewer root only.
- vitest in node: `edit/*.ts` pure modules only (`editor.ts` takes a `PointBuffers`-shaped object and is tested with `createPointBuffers`, which is node-safe). GPU/DOM verified with Playwright MCP.
- Console: 0 errors, only the benign `PCFSoftShadowMap` warnings.
- Data: `public/data/{demo,full}`. Dev harness `?data=demo|full|<export-name>`.
- Branch `phase-5-editing` from `main`. Commit messages concise, no attribution lines.

---

### Task 0: Branch, fflate, flags mirror, store `edit` state

**Files:**
- Modify: `package.json` (fflate), `src/viewer/render/PointBuffers.ts`, `src/viewer/state/store.ts`
- Create: `src/viewer/edit/flags.ts`
- Test: `src/viewer/render/PointBuffers.test.ts`, `src/viewer/edit/flags.test.ts`, `src/viewer/state/store.test.ts`

**Interfaces:**
- Produces on `PointBuffers`: `flagBytes: Uint8Array` (view over `flags.array.buffer`), `uploadFlagsRange(minIdx: number, maxIdx: number): void` (inclusive point indices).
- Produces in `edit/flags.ts`: re-exports `FLAG_*`; `type Range = { min: number; max: number }`; `unionRange(a: Range | null, b: Range | null): Range | null`; `countFlags(bytes: Uint8Array): { selected: number; hidden: number; deleted: number }`; `wordOf(bytes: Uint8Array, i: number): number` (packs bytes `4i..4i+3` little-endian — test oracle for the vertex unpack); `selectionRange(bytes: Uint8Array): Range | null`.
- Produces in store: `SelectMode = 'replace' | 'add' | 'subtract'`; `EditTool = 'orbit' | 'lasso'`; `SplitSide = 'all' | 'A' | 'B'`; `EditState { tool: EditTool; busy: boolean; counts: { selected: number; hidden: number; deleted: number }; undoDepth: number; redoDepth: number; splitSide: SplitSide; split: { fitted: boolean; inlierRatio: number | null }; lasso: { gpuMs: number | null; readbackMs: number; selected: number } | null; pickMs: number | null; message?: string }`; `ViewerState.edit`; `initialState.edit = { tool: 'orbit', busy: false, counts: { selected: 0, hidden: 0, deleted: 0 }, undoDepth: 0, redoDepth: 0, splitSide: 'all', split: { fitted: false, inlierRatio: null }, lasso: null, pickMs: null }`.

- [ ] **Step 1: Branch + dep**

```bash
cd ~/Developer/Graphics/TS_PointCloud && git checkout main && git pull -q && git checkout -b phase-5-editing
npm install fflate@0.8.3 && grep '"fflate": "0.8.3"' package.json
```

- [ ] **Step 2: Failing tests**

Append to `src/viewer/render/PointBuffers.test.ts` inside the `describe`:

```ts
  it('flagBytes aliases the flags words little-endian and uploadFlagsRange is word-aligned', () => {
    const b = createPointBuffers(10, 1)
    b.flagBytes[5] = 0x82
    expect((b.flags.array as Uint32Array)[1]).toBe(0x82 << 8)
    b.uploadFlagsRange(5, 9)          // bytes 5..9 → words 1..2
    expect(b.flags.updateRanges).toEqual([{ start: 1, count: 2 }])
    expect(b.flags.version).toBe(1)
  })
```

Create `src/viewer/edit/flags.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FLAG_SELECTED, FLAG_HIDDEN, FLAG_DELETED, countFlags, unionRange, wordOf, selectionRange } from './flags'
import { unpackWords } from '../format/quant'

describe('flags helpers', () => {
  it('unionRange merges and passes null through', () => {
    expect(unionRange(null, null)).toBeNull()
    expect(unionRange({ min: 3, max: 5 }, null)).toEqual({ min: 3, max: 5 })
    expect(unionRange({ min: 3, max: 5 }, { min: 1, max: 4 })).toEqual({ min: 1, max: 5 })
  })
  it('countFlags counts each bit independently', () => {
    const b = new Uint8Array([FLAG_SELECTED, FLAG_HIDDEN | FLAG_SELECTED, FLAG_DELETED, 0])
    expect(countFlags(b)).toEqual({ selected: 2, hidden: 1, deleted: 1 })
  })
  it('wordOf packs byte i at shift (i & 3) * 8 — the vertex-stage unpack', () => {
    const b = new Uint8Array([1, 2, 4, 8, 16])
    expect(wordOf(b, 0)).toBe(1 | (2 << 8) | (4 << 16) | (8 << 24))
    expect(wordOf(b, 1)).toBe(16)
    for (let i = 0; i < 5; i++) expect((wordOf(b, i >> 2) >>> ((i & 3) * 8)) & 0xff).toBe(b[i])
  })
  it('selectionRange spans the first..last selected byte', () => {
    const b = new Uint8Array(8); b[2] = FLAG_SELECTED; b[6] = FLAG_SELECTED | FLAG_HIDDEN
    expect(selectionRange(b)).toEqual({ min: 2, max: 6 })
    expect(selectionRange(new Uint8Array(4))).toBeNull()
  })
})
```

Append to `src/viewer/state/store.test.ts`:

```ts
  it('edit defaults', () => {
    expect(initialState.edit.tool).toBe('orbit')
    expect(initialState.edit.counts).toEqual({ selected: 0, hidden: 0, deleted: 0 })
    expect(initialState.edit.busy).toBe(false)
  })
```

- [ ] **Step 3: Run, expect failures**

Run: `npx vitest run src/viewer/render src/viewer/edit src/viewer/state`
Expected: FAIL — `flagBytes` undefined, `./flags` missing, `edit` undefined.

- [ ] **Step 4: Implement**

`PointBuffers.ts` — add to the interface and factory:

```ts
  flagBytes: Uint8Array        // byte i = point i; view over flags.array.buffer (CPU source of truth for edits)
  uploadFlagsRange(minIdx: number, maxIdx: number): void   // inclusive point indices → one word-aligned update range
```
```ts
  const flagBytes = new Uint8Array(flags.array.buffer)
  ...
    flagBytes,
    uploadFlagsRange(minIdx, maxIdx) {
      const w0 = minIdx >> 2, w1 = maxIdx >> 2
      flags.addUpdateRange(w0, w1 - w0 + 1)
      flags.needsUpdate = true
    },
```

`src/viewer/edit/flags.ts`:

```ts
export { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B } from '../render/PointBuffers'
import { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED } from '../render/PointBuffers'

export interface Range { min: number; max: number }   // inclusive point indices

export function unionRange(a: Range | null, b: Range | null): Range | null {
  if (!a) return b
  if (!b) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
}

export function countFlags(bytes: Uint8Array): { selected: number; hidden: number; deleted: number } {
  let selected = 0, hidden = 0, deleted = 0
  for (let i = 0; i < bytes.length; i++) {
    const f = bytes[i]
    if (f === 0) continue
    if (f & FLAG_SELECTED) selected++
    if (f & FLAG_HIDDEN) hidden++
    if (f & FLAG_DELETED) deleted++
  }
  return { selected, hidden, deleted }
}

export function selectionRange(bytes: Uint8Array): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < bytes.length; i++) if (bytes[i] & FLAG_SELECTED) { if (min < 0) min = i; max = i }
  return min < 0 ? null : { min, max }
}

// Word w as the vertex stage reads it: byte 4w+k at shift 8k (little-endian).
export function wordOf(bytes: Uint8Array, w: number): number {
  const b = (k: number) => bytes[w * 4 + k] ?? 0
  return (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0
}
```

`store.ts` — add the types from Interfaces above, `edit: EditState` on `ViewerState`, the `initialState.edit` literal.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "phase 5: fflate, flags byte mirror + uploadFlagsRange, edit store state"
```

### Task 1: Undo ring

**Files:**
- Create: `src/viewer/edit/undo.ts`
- Test: `src/viewer/edit/undo.test.ts`

**Interfaces:**
- Produces: `interface UndoCommand { min: number; max: number; flags: Uint8Array }` (dense slice `bytes[min..max]` of the *other* state — before the edit while on the undo stack, after the edit while on the redo stack); `createUndoRing(bytes: Uint8Array, opts?: { maxCommands?: number; maxBytes?: number }): UndoRing`; `interface UndoRing { push(min: number, max: number): void; undo(): Range | null; redo(): Range | null; undoDepth(): number; redoDepth(): number; bytes(): number; clear(): void }`. `push` copies `bytes[min..max]` **before** the caller mutates (call it first). `undo`/`redo` swap the stored slice with the live bytes and return the range to upload. Defaults `maxCommands = 30`, `maxBytes = 256 × 2²⁰`; eviction drops the oldest undo entries until both hold (counting undo + redo bytes).

- [ ] **Step 1: Failing tests** — `src/viewer/edit/undo.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run src/viewer/edit/undo.test.ts` → module missing.

- [ ] **Step 3: Implement** — `src/viewer/edit/undo.ts`:

```ts
import type { Range } from './flags'

export interface UndoCommand { min: number; max: number; flags: Uint8Array }
export interface UndoRing {
  push(min: number, max: number): void      // call BEFORE mutating bytes[min..max]
  undo(): Range | null
  redo(): Range | null
  undoDepth(): number
  redoDepth(): number
  bytes(): number
  clear(): void
}

const MAX_COMMANDS = 30
const MAX_BYTES = 256 * 2 ** 20

// Each command holds one dense slice; undo/redo swap it with the live bytes, so a command costs the same
// whichever stack it sits on. Whole-buffer edits (lasso, isolate, unhide, clear) cost N bytes each.
export function createUndoRing(live: Uint8Array, opts: { maxCommands?: number; maxBytes?: number } = {}): UndoRing {
  const maxCommands = opts.maxCommands ?? MAX_COMMANDS
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let undo: UndoCommand[] = []
  let redo: UndoCommand[] = []
  let total = 0
  const swap = (c: UndoCommand) => {
    const cur = live.slice(c.min, c.max + 1)
    live.set(c.flags, c.min)
    c.flags = cur
  }
  const evict = () => { while (undo.length > 0 && (undo.length > maxCommands || total > maxBytes)) total -= undo.shift()!.flags.length }
  return {
    push(min, max) {
      for (const c of redo) total -= c.flags.length
      redo = []
      const flags = live.slice(min, max + 1)
      undo.push({ min, max, flags }); total += flags.length
      evict()
    },
    undo() { const c = undo.pop(); if (!c) return null; swap(c); redo.push(c); return { min: c.min, max: c.max } },
    redo() { const c = redo.pop(); if (!c) return null; swap(c); undo.push(c); return { min: c.min, max: c.max } },
    undoDepth: () => undo.length,
    redoDepth: () => redo.length,
    bytes: () => total,
    clear() { undo = []; redo = []; total = 0 },
  }
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run src/viewer/edit/undo.test.ts`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "edit: undo ring (30 cmds / 256 MB, slice swap)"`

### Task 2: Ops (pure, over the byte mirror)

**Files:**
- Create: `src/viewer/edit/ops.ts`
- Test: `src/viewer/edit/ops.test.ts`

**Interfaces:**
- Consumes: `FLAG_*`, `Range`, `SplitSide` (store).
- Produces (all return the touched `Range | null` — `null` = nothing changed; none upload or record undo, the editor does):
  `sideMask(side: SplitSide): number` (`0` for `'all'`, else the split bit); `isSubject(f: number, side: SplitSide): boolean` (`selected && (side === 'all' || f & sideMask)`);
  `isolate(bytes, side): Range | null` — set `hidden` on every point that is not a subject and not deleted;
  `hide(bytes, side)` — subjects get `hidden`, lose `selected | splitA | splitB`;
  `del(bytes, side)` — subjects get `deleted`, lose `selected | splitA | splitB`;
  `unhideAll(bytes)` — clear `hidden` everywhere;
  `clearSelection(bytes, range: Range | null)` — clear `selected | splitA | splitB` over `range` (the editor passes `selRange`; `null` → whole buffer);
  `applyPick(bytes, idx: number, mode: SelectMode, selRange: Range | null): Range | null` — replace: clear over `selRange`, set `idx`; add: set; subtract: clear `idx`;
  `tagSplit(bytes, side: (i: number) => boolean): Range | null` — over selected points, set `splitA` where `side(i)` else `splitB` (clearing the other bit).

- [ ] **Step 1: Failing tests** — `src/viewer/edit/ops.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { isolate, hide, del, unhideAll, clearSelection, applyPick, tagSplit } from './ops'

const mk = (...v: number[]) => new Uint8Array(v)

describe('ops', () => {
  it('isolate hides non-selected, keeps deleted untouched, returns the touched range', () => {
    const b = mk(0, S, 0, D, 0)
    expect(isolate(b, 'all')).toEqual({ min: 0, max: 4 })
    expect(Array.from(b)).toEqual([H, S, H, D, H])
  })
  it('hide / delete take selected (with side filter) and clear selection + split bits', () => {
    const b = mk(S | A, S | B, S, 0)
    expect(hide(b, 'A')).toEqual({ min: 0, max: 0 })
    expect(Array.from(b)).toEqual([H, S | B, S, 0])
    expect(del(b, 'all')).toEqual({ min: 1, max: 2 })
    expect(Array.from(b)).toEqual([H, D, D, 0])
    expect(del(b, 'all')).toBeNull()
  })
  it('unhideAll and clearSelection', () => {
    const b = mk(H, H | S, S | A, D)
    expect(unhideAll(b)).toEqual({ min: 0, max: 1 })
    expect(Array.from(b)).toEqual([0, S, S | A, D])
    expect(clearSelection(b, { min: 1, max: 2 })).toEqual({ min: 1, max: 2 })
    expect(Array.from(b)).toEqual([0, 0, 0, D])
    expect(clearSelection(b, null)).toBeNull()
  })
  it('applyPick modes', () => {
    const b = mk(0, S, 0, 0)
    expect(applyPick(b, 3, 'add', { min: 1, max: 1 })).toEqual({ min: 3, max: 3 })
    expect(applyPick(b, 0, 'replace', { min: 1, max: 3 })).toEqual({ min: 0, max: 1 })   // only bytes 0..1 actually changed
    expect(Array.from(b)).toEqual([S, 0, 0, 0])
    expect(applyPick(b, 0, 'subtract', { min: 0, max: 0 })).toEqual({ min: 0, max: 0 })
    expect(Array.from(b)).toEqual([0, 0, 0, 0])
  })
  it('tagSplit tags selected points by side predicate', () => {
    const b = mk(S, S | B, 0, S)
    expect(tagSplit(b, (i) => i < 2)).toEqual({ min: 0, max: 3 })
    expect(Array.from(b)).toEqual([S | A, S | A, 0, S | B])
  })
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run src/viewer/edit/ops.test.ts`.

- [ ] **Step 3: Implement** — `src/viewer/edit/ops.ts`:

```ts
import { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B, type Range } from './flags'
import type { SelectMode, SplitSide } from '../state/store'

const SEL_BITS = FLAG_SELECTED | FLAG_SPLIT_A | FLAG_SPLIT_B

export function sideMask(side: SplitSide): number { return side === 'A' ? FLAG_SPLIT_A : side === 'B' ? FLAG_SPLIT_B : 0 }
export function isSubject(f: number, side: SplitSide): boolean {
  return (f & FLAG_SELECTED) !== 0 && (side === 'all' || (f & sideMask(side)) !== 0)
}

// Generic pass: `next(f, i)` returns the new byte; the touched range spans the first..last changed index.
function pass(bytes: Uint8Array, from: number, to: number, next: (f: number, i: number) => number): Range | null {
  let min = -1, max = -1
  for (let i = from; i <= to; i++) {
    const f = bytes[i], g = next(f, i)
    if (g !== f) { bytes[i] = g; if (min < 0) min = i; max = i }
  }
  return min < 0 ? null : { min, max }
}
const whole = (b: Uint8Array, next: (f: number, i: number) => number) => pass(b, 0, b.length - 1, next)

export const isolate = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) || (f & FLAG_DELETED) ? f : f | FLAG_HIDDEN)
export const hide = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) ? (f & ~SEL_BITS) | FLAG_HIDDEN : f)
export const del = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) ? (f & ~SEL_BITS) | FLAG_DELETED : f)
export const unhideAll = (b: Uint8Array) => whole(b, (f) => f & ~FLAG_HIDDEN)
export const clearSelection = (b: Uint8Array, range: Range | null) =>
  range ? pass(b, range.min, range.max, (f) => f & ~SEL_BITS) : whole(b, (f) => f & ~SEL_BITS)

export function applyPick(b: Uint8Array, idx: number, mode: SelectMode, selRange: Range | null): Range | null {
  if (mode === 'subtract') return pass(b, idx, idx, (f) => f & ~SEL_BITS)
  const cleared = mode === 'replace' ? clearSelection(b, selRange) : null
  const set = pass(b, idx, idx, (f) => f | FLAG_SELECTED)
  return cleared && set ? { min: Math.min(cleared.min, set.min), max: Math.max(cleared.max, set.max) } : cleared ?? set
}

export const tagSplit = (b: Uint8Array, sideA: (i: number) => boolean) =>
  whole(b, (f, i) => (f & FLAG_SELECTED) ? (f & ~(FLAG_SPLIT_A | FLAG_SPLIT_B)) | (sideA(i) ? FLAG_SPLIT_A : FLAG_SPLIT_B) : f)
```

- [ ] **Step 4: Run, expect pass**; `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "edit: pure flag ops with split-side filter"`

### Task 3: Plane fit (RANSAC + PCA)

**Files:**
- Create: `src/viewer/edit/plane.ts`
- Test: `src/viewer/edit/plane.test.ts`

**Interfaces:**
- Consumes: `smallestEigenvector(m: number[]): [number, number, number] | null` from `compute/cpu/normals.ts` (row-major 3×3).
- Produces: `interface Plane { normal: [number, number, number]; d: number; inlierRatio: number }` (plane `n·p + d = 0`, `|n| = 1`); `mulberry32(seed: number): () => number`; `fitPlane(pts: Float32Array, n: number, threshold: number, opts?: { iterations?: number; seed?: number }): Plane | null` (`pts` = xyz triples; `null` when `n < 3` or every hypothesis is degenerate); `signedDistance(p: Plane, x: number, y: number, z: number): number`; `samplePoints(src: Float32Array, n: number, cap: number): { pts: Float32Array; n: number }` (uniform stride sample to ≤ `cap`).

- [ ] **Step 1: Failing tests** — `src/viewer/edit/plane.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fitPlane, mulberry32, signedDistance, samplePoints } from './plane'

// Gaussian-ish noise via sum of uniforms (Irwin–Hall), deterministic.
function synthetic(seed: number, n: number, normal: [number, number, number], d: number, noise: number, outlierFrac: number) {
  const rnd = mulberry32(seed)
  const g = () => (rnd() + rnd() + rnd() + rnd() - 2) * Math.sqrt(3) * noise
  const [nx, ny, nz] = normal
  const pts = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    let x = (rnd() - 0.5) * 100, y = (rnd() - 0.5) * 100
    // solve nz*z = -d - nx*x - ny*y (normals in tests have nz != 0)
    let z = (-d - nx * x - ny * y) / nz + g()
    if (rnd() < outlierFrac) z += (rnd() - 0.5) * 60
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z
  }
  return pts
}
const deg = (a: [number, number, number], b: [number, number, number]) =>
  Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI

describe('fitPlane', () => {
  it('recovers a tilted plane under noise and 30% outliers within 1° / threshold', () => {
    const len = Math.hypot(0.3, -0.2, 1)
    const normal: [number, number, number] = [0.3 / len, -0.2 / len, 1 / len]
    const pts = synthetic(1, 4000, normal, -5, 0.05, 0.3)
    const p = fitPlane(pts, 4000, 0.2, { seed: 7 })!
    expect(p).not.toBeNull()
    expect(deg(p.normal, normal)).toBeLessThan(1)
    expect(Math.abs(p.d - -5 * Math.sign(p.normal[2] / normal[2]))).toBeLessThan(0.2)
    expect(p.inlierRatio).toBeGreaterThan(0.6)
  })
  it('returns null below 3 points', () => {
    expect(fitPlane(new Float32Array(6), 2, 1)).toBeNull()
  })
  it('signedDistance is zero on the plane', () => {
    const p = { normal: [0, 0, 1] as [number, number, number], d: -2, inlierRatio: 1 }
    expect(signedDistance(p, 5, 5, 2)).toBeCloseTo(0)
    expect(signedDistance(p, 0, 0, 3)).toBeCloseTo(1)
  })
  it('samplePoints strides down to the cap', () => {
    const src = new Float32Array(30)
    for (let i = 0; i < 10; i++) src[i * 3] = i
    const s = samplePoints(src, 10, 4)
    expect(s.n).toBe(4)
    expect(Array.from(s.pts.filter((_, k) => k % 3 === 0))).toEqual([0, 2, 5, 7])
    expect(samplePoints(src, 10, 20).n).toBe(10)
  })
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run src/viewer/edit/plane.test.ts`.

- [ ] **Step 3: Implement** — `src/viewer/edit/plane.ts`:

```ts
import { smallestEigenvector } from '../compute/cpu/normals'

export interface Plane { normal: [number, number, number]; d: number; inlierRatio: number }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const signedDistance = (p: Plane, x: number, y: number, z: number) => p.normal[0] * x + p.normal[1] * y + p.normal[2] * z + p.d

// Uniform stride sample (index k → floor(k * n / cap)); the whole set when n <= cap.
export function samplePoints(src: Float32Array, n: number, cap: number): { pts: Float32Array; n: number } {
  if (n <= cap) return { pts: src, n }
  const pts = new Float32Array(cap * 3)
  for (let k = 0; k < cap; k++) {
    const i = Math.floor((k * n) / cap)
    pts[k * 3] = src[i * 3]; pts[k * 3 + 1] = src[i * 3 + 1]; pts[k * 3 + 2] = src[i * 3 + 2]
  }
  return { pts, n: cap }
}

function planeThrough(pts: Float32Array, a: number, b: number, c: number): Plane | null {
  const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2]
  const ux = pts[b * 3] - ax, uy = pts[b * 3 + 1] - ay, uz = pts[b * 3 + 2] - az
  const vx = pts[c * 3] - ax, vy = pts[c * 3 + 1] - ay, vz = pts[c * 3 + 2] - az
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  if (!(len > 1e-12)) return null
  nx /= len; ny /= len; nz /= len
  return { normal: [nx, ny, nz], d: -(nx * ax + ny * ay + nz * az), inlierRatio: 0 }
}

function countInliers(pts: Float32Array, n: number, p: Plane, t: number): number {
  let c = 0
  for (let i = 0; i < n; i++) if (Math.abs(signedDistance(p, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])) <= t) c++
  return c
}

// PCA over the inliers: normal = smallest eigenvector of the covariance, plane through the centroid.
function refine(pts: Float32Array, n: number, p: Plane, t: number): Plane {
  let cx = 0, cy = 0, cz = 0, m = 0
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (Math.abs(signedDistance(p, x, y, z)) > t) continue
    cx += x; cy += y; cz += z; m++
  }
  cx /= m; cy /= m; cz /= m
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (Math.abs(signedDistance(p, x, y, z)) > t) continue
    const dx = x - cx, dy = y - cy, dz = z - cz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  const e = smallestEigenvector([xx / m, xy / m, xz / m, xy / m, yy / m, yz / m, xz / m, yz / m, zz / m])
  if (!e) return { ...p, inlierRatio: m / n }
  // keep the RANSAC orientation so A/B sides are stable
  const flip = e[0] * p.normal[0] + e[1] * p.normal[1] + e[2] * p.normal[2] < 0 ? -1 : 1
  const normal: [number, number, number] = [e[0] * flip, e[1] * flip, e[2] * flip]
  return { normal, d: -(normal[0] * cx + normal[1] * cy + normal[2] * cz), inlierRatio: m / n }
}

// RANSAC (3-point hypotheses) then PCA refine. `pts` = xyz triples, `threshold` = inlier distance.
export function fitPlane(pts: Float32Array, n: number, threshold: number, opts: { iterations?: number; seed?: number } = {}): Plane | null {
  if (n < 3) return null
  const rnd = mulberry32(opts.seed ?? 1)
  const iters = opts.iterations ?? 200
  let best: Plane | null = null, bestCount = -1
  for (let k = 0; k < iters; k++) {
    const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n), c = Math.floor(rnd() * n)
    if (a === b || b === c || a === c) continue
    const p = planeThrough(pts, a, b, c)
    if (!p) continue
    const count = countInliers(pts, n, p, threshold)
    if (count > bestCount) { best = p; bestCount = count }
  }
  return best ? refine(pts, n, best, threshold) : null
}
```

- [ ] **Step 4: Run, expect pass**. If the 1° bound fails, print `deg(...)` and inspect: with 4000 points, noise σ 0.05 and threshold 0.2, the PCA refine over ~70 % inliers should land ≪ 1°; a failure means the covariance is built from the wrong indices, not a loose bound.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "edit: RANSAC + PCA plane fit (seeded)"`

### Task 4: Lasso geometry + CPU projection reference

**Files:**
- Create: `src/viewer/edit/lasso.ts`, `src/viewer/edit/project.ts`
- Test: `src/viewer/edit/lasso.test.ts`, `src/viewer/edit/project.test.ts`

**Interfaces:**
- `lasso.ts`: `MAX_LASSO_VERTS = 256`; `type Poly = [number, number][]`; `pointInPolygon(x: number, y: number, poly: Float32Array, count: number): boolean` (even-odd crossing rule, `poly` = xy pairs — **the same rule and edge test as the WGSL kernel**: edge `(i, j = (i + count − 1) % count)`, crossing when `(yi > y) !== (yj > y)` and `x < (xj − xi) × (y − yi) / (yj − yi) + xi`); `polyBounds(poly: Float32Array, count: number): [number, number, number, number]` (`minX, minY, maxX, maxY`); `packPoly(poly: Poly): { data: Float32Array; count: number }` (into a `Float32Array(MAX_LASSO_VERTS × 2)`, drops verts past the cap); `simplifyPoly(poly: Poly, minDistPx: number): Poly` (drop a vertex closer than `minDistPx` to the previous kept one; keeps the first).
- `project.ts`: `type Mat4 = Float32Array | number[]` (column-major 16, as `THREE.Matrix4.elements`); `projectPoint(x, y, z, viewProj: Mat4, w: number, h: number): [sx: number, sy: number, depth: number] | null` (`null` when `clipW ≤ 0` or depth outside `[0, 1]`; `sx = (ndc.x × 0.5 + 0.5) × w`, `sy = (0.5 − ndc.y × 0.5) × h`); `decodeWorld(words: Uint32Array, i: number, dqScale: [n,n,n], dqMin: [n,n,n]): [number, number, number]`; `cpuPick(words, n, dqScale, dqMin, viewProj, w, h, cx, cy, visible: (i: number) => boolean, radiusPx: (i: number, depth: number) => number): number | null` (the DEV reference passes the attenuated size from the view matrix; tests pass a constant) — nearest-depth point within radius (ties: lowest index) — used by the Playwright acceptance and by `cpuLasso(words, n, ..., poly, count, visible): Uint32Array` (indices inside).

- [ ] **Step 1: Failing tests**

`src/viewer/edit/lasso.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pointInPolygon, polyBounds, packPoly, simplifyPoly, MAX_LASSO_VERTS } from './lasso'

const P = (...xy: number[]) => new Float32Array(xy)
describe('pointInPolygon (even-odd)', () => {
  const square = P(0, 0, 10, 0, 10, 10, 0, 10)
  it('convex', () => {
    expect(pointInPolygon(5, 5, square, 4)).toBe(true)
    expect(pointInPolygon(15, 5, square, 4)).toBe(false)
    expect(pointInPolygon(-1, 5, square, 4)).toBe(false)
  })
  it('concave (U shape)', () => {
    const u = P(0, 0, 10, 0, 10, 10, 7, 10, 7, 3, 3, 3, 3, 10, 0, 10)
    expect(pointInPolygon(5, 8, u, 8)).toBe(false)   // in the notch
    expect(pointInPolygon(5, 1, u, 8)).toBe(true)
    expect(pointInPolygon(1, 8, u, 8)).toBe(true)
  })
  it('self-touching bow-tie: even-odd counts each lobe once', () => {
    const bow = P(0, 0, 10, 10, 10, 0, 0, 10)
    expect(pointInPolygon(2, 5, bow, 4)).toBe(true)
    expect(pointInPolygon(8, 5, bow, 4)).toBe(true)
    expect(pointInPolygon(5, 2, bow, 4)).toBe(false)
  })
  it('points on a left edge count as inside, on a right edge outside (half-open rule)', () => {
    expect(pointInPolygon(0, 5, square, 4)).toBe(true)
    expect(pointInPolygon(10, 5, square, 4)).toBe(false)
  })
})
describe('polygon helpers', () => {
  it('polyBounds', () => { expect(polyBounds(P(1, 2, -3, 4, 5, -6), 3)).toEqual([-3, -6, 5, 4]) })
  it('packPoly caps at MAX_LASSO_VERTS', () => {
    const poly = Array.from({ length: 300 }, (_, i) => [i, i] as [number, number])
    const { data, count } = packPoly(poly)
    expect(count).toBe(MAX_LASSO_VERTS)
    expect(data.length).toBe(MAX_LASSO_VERTS * 2)
    expect(data[2 * 255]).toBe(255)
  })
  it('simplifyPoly drops near-duplicate vertices', () => {
    expect(simplifyPoly([[0, 0], [1, 0], [5, 0], [5.5, 0], [10, 0]], 2)).toEqual([[0, 0], [5, 0], [10, 0]])
  })
})
```

`src/viewer/edit/project.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { projectPoint, cpuPick, decodeWorld } from './project'
import { packWords } from '../format/quant'

// Column-major perspective (WebGPU depth 0..1): fov 90°, aspect 1, near 1, far 100.
function persp(): number[] {
  const n = 1, f = 100
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, f / (n - f), -1, 0, 0, (n * f) / (n - f), 0]
}
describe('projectPoint', () => {
  it('maps the view axis to the viewport centre with depth in [0,1]', () => {
    const r = projectPoint(0, 0, -10, persp(), 800, 600)!
    expect(r[0]).toBeCloseTo(400); expect(r[1]).toBeCloseTo(300)
    expect(r[2]).toBeGreaterThan(0); expect(r[2]).toBeLessThan(1)
  })
  it('y up in NDC is y down on screen; behind camera is null', () => {
    const r = projectPoint(0, 5, -10, persp(), 800, 600)!
    expect(r[1]).toBeLessThan(300)
    expect(projectPoint(0, 0, 10, persp(), 800, 600)).toBeNull()
  })
})
describe('cpuPick', () => {
  it('returns the nearest-depth point within radius, honouring visibility', () => {
    // three points on the view axis at z = -10, -20, -30 (q values chosen with dqScale 1, dqMin 0 → world = q)
    const words = new Uint32Array(6)
    const put = (i: number, z: number) => { const [a, b] = packWords(0, 0, z, 0); words[i * 2] = a; words[i * 2 + 1] = b }
    put(0, 30); put(1, 10); put(2, 20)
    const dq: [number, number, number] = [1, 1, 1], mn: [number, number, number] = [0, 0, -40]   // world z = q - 40 → -10, -30, -20
    const vp = persp()
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 400, 300, () => true, () => 3)).toBe(0)      // z = -10 is nearest
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 400, 300, (i) => i !== 0, () => 3)).toBe(2)   // then z = -20
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 700, 300, () => true, () => 3)).toBeNull()
    expect(decodeWorld(words, 0, dq, mn)).toEqual([0, 0, -10])
  })
})
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run src/viewer/edit`.

- [ ] **Step 3: Implement**

`src/viewer/edit/lasso.ts`:

```ts
export const MAX_LASSO_VERTS = 256
export type Poly = [number, number][]

// Even-odd crossing test, identical to the WGSL `pcvInPoly` in compute/wgsl/select.ts (edge i–j, j = previous vertex).
export function pointInPolygon(x: number, y: number, poly: Float32Array, count: number): boolean {
  let inside = false
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function polyBounds(poly: Float32Array, count: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const x = poly[i * 2], y = poly[i * 2 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

export function packPoly(poly: Poly): { data: Float32Array; count: number } {
  const count = Math.min(poly.length, MAX_LASSO_VERTS)
  const data = new Float32Array(MAX_LASSO_VERTS * 2)
  for (let i = 0; i < count; i++) { data[i * 2] = poly[i][0]; data[i * 2 + 1] = poly[i][1] }
  return { data, count }
}

export function simplifyPoly(poly: Poly, minDistPx: number): Poly {
  const out: Poly = []
  for (const p of poly) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDistPx) out.push(p)
  }
  return out
}
```

`src/viewer/edit/project.ts`:

```ts
import { pointInPolygon, polyBounds } from './lasso'

export type Mat4 = Float32Array | number[]   // column-major, THREE.Matrix4.elements
type V3 = [number, number, number]

// CPU mirror of the kernel prologue: clip = viewProj * (p, 1); screen px = ((ndc.x*0.5+0.5)*w, (0.5-ndc.y*0.5)*h); depth = clip.z / clip.w.
export function projectPoint(x: number, y: number, z: number, m: Mat4, w: number, h: number): [number, number, number] | null {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  if (cw <= 0) return null
  const depth = cz / cw
  if (depth < 0 || depth > 1) return null
  return [(cx / cw * 0.5 + 0.5) * w, (0.5 - cy / cw * 0.5) * h, depth]
}

export function decodeWorld(words: Uint32Array, i: number, dqScale: V3, dqMin: V3): V3 {
  const w0 = words[i * 2], w1 = words[i * 2 + 1]
  return [(w0 & 0xffff) * dqScale[0] + dqMin[0], (w0 >>> 16) * dqScale[1] + dqMin[1], (w1 & 0xffff) * dqScale[2] + dqMin[2]]
}

// radiusPx(i, depth): the caller supplies the attenuated size (needs the view matrix) or a constant.
export function cpuPick(words: Uint32Array, n: number, dqScale: V3, dqMin: V3, viewProj: Mat4, w: number, h: number,
  cx: number, cy: number, visible: (i: number) => boolean, radiusPx: (i: number, depth: number) => number): number | null {
  let best = -1, bestDepth = Infinity
  for (let i = 0; i < n; i++) {
    if (!visible(i)) continue
    const [x, y, z] = decodeWorld(words, i, dqScale, dqMin)
    const s = projectPoint(x, y, z, viewProj, w, h)
    if (!s) continue
    const r = radiusPx(i, s[2])
    if ((s[0] - cx) ** 2 + (s[1] - cy) ** 2 > r * r) continue
    if (s[2] < bestDepth) { bestDepth = s[2]; best = i }
  }
  return best < 0 ? null : best
}

export function cpuLasso(words: Uint32Array, n: number, dqScale: V3, dqMin: V3, viewProj: Mat4, w: number, h: number,
  poly: Float32Array, count: number, visible: (i: number) => boolean): Uint32Array {
  const [minX, minY, maxX, maxY] = polyBounds(poly, count)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (!visible(i)) continue
    const [x, y, z] = decodeWorld(words, i, dqScale, dqMin)
    const s = projectPoint(x, y, z, viewProj, w, h)
    if (!s || s[0] < minX || s[0] > maxX || s[1] < minY || s[1] > maxY) continue
    if (pointInPolygon(s[0], s[1], poly, count)) out.push(i)
  }
  return Uint32Array.from(out)
}
```

- [ ] **Step 4: Run, expect pass**; `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "edit: even-odd lasso test, polygon packing, CPU projection/pick reference"`

### Task 5: Editor (CPU glue) + material highlight

**Files:**
- Create: `src/viewer/edit/editor.ts`
- Modify: `src/viewer/render/pointMaterial.ts`, `src/viewer/loader/useLoader.ts` (`Loaded.editor`), `src/viewer/render/ChunkSprites.tsx` (accent from CSS)
- Test: `src/viewer/edit/editor.test.ts`

**Interfaces:**
- Consumes: `PointBuffers.flagBytes/uploadFlagsRange/qpos/count`, `Store<ViewerState>`, `ops`, `createUndoRing`, `fitPlane/samplePoints/signedDistance`, `countFlags/selectionRange/unionRange`, `dequantScale`, `spacingOf`.
- Produces `edit/editor.ts`: `createEditor(buffers: PointBuffers, manifest: Manifest, store: Store<ViewerState>): Editor` with
  ```ts
  interface Editor {
    bytes: Uint8Array                                   // = buffers.flagBytes
    isolate(): void; hide(): void; del(): void; unhideAll(): void; clearSelection(): void   // side = store.edit.splitSide
    split(): void                                       // fit + tagSplit; sets edit.split, message on < 3 pts
    pick(idx: number | null, mode: SelectMode): void    // CPU apply of a GPU pick result (null = miss)
    beginGpuEdit(): void                                // undo.push(0, N-1); store busy = true
    endGpuEdit(): void                                  // recount, selRange, busy = false (call after the readback landed in bytes)
    undo(): void; redo(): void
    refresh(): void                                     // counts + depths → store
    dispose(): void
  }
  ```
  Every CPU op: `if (busy) return` → `undo.push(range)` → mutate → `uploadFlagsRange` → `refresh()`. The touched range is only known after the pass, so whole-buffer ops (isolate, hide, del, unhideAll, split) push `(0, N−1)` first and accept the N-byte cost (the spec budgets whole-buffer commands); `clearSelection` / `pick` know their range up front (`selRange ∪ {idx}`). If the op returns `null` (nothing changed) the pushed command is removed with `undo.dropLast()` — a new `UndoRing` method added in this task (pops the newest undo command, subtracts its bytes).
- Produces on `PointMaterialHandle`: `setHighlight(c: { selected?: string; splitA?: string; splitB?: string }): void` (CSS hex strings).
- Produces on `Loaded`: `editor: Editor`.

- [ ] **Step 1: Failing tests** — `src/viewer/edit/editor.test.ts` (node-safe: `createPointBuffers` only touches typed arrays and TSL node constructors, already exercised by `PointBuffers.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { createPointBuffers } from '../render/PointBuffers'
import { createStore, initialState } from '../state/store'
import { createEditor } from './editor'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { packWords } from '../format/quant'
import type { Manifest } from '../loader/manifest'

// 100 m cube; 8 points on a slightly noisy plane z ≈ 50 (world): x spread 0..85, y 0..40, z = 49 or 51 alternating.
const manifest: Manifest = {
  version: 1, name: 't', units: 'm', bounds: { min: [0, 0, 0], max: [100, 100, 100] }, pointCount: 8, bytesPerPoint: 8,
  file: 'points.bin', classMap: {}, chunks: [{ offset: 0, count: 8, bounds: { min: [0, 0, 0], max: [100, 100, 100] } }],
}
function setup() {
  const buffers = createPointBuffers(8, 1)
  const q = buffers.qpos.array as Uint32Array
  for (let i = 0; i < 8; i++) { const [a, b] = packWords(i * 8000, (i * 3000) % 30000, i % 2 ? 33422 : 32112, 0); q[i * 2] = a; q[i * 2 + 1] = b }
  const store = createStore(initialState)
  return { buffers, store, editor: createEditor(buffers, manifest, store) }
}
describe('editor', () => {
  it('pick replace/add, hide, undo/redo upload ranges and refresh counts', () => {
    const { buffers, store, editor } = setup()
    editor.pick(2, 'replace'); editor.pick(5, 'add')
    expect(store.get().edit.counts.selected).toBe(2)
    expect(buffers.flags.updateRanges.at(-1)).toEqual({ start: 1, count: 1 })
    editor.hide()
    expect(Array.from(editor.bytes)).toEqual([0, 0, H, 0, 0, H, 0, 0])
    expect(store.get().edit.counts).toEqual({ selected: 0, hidden: 2, deleted: 0 })
    expect(store.get().edit.undoDepth).toBe(3)
    editor.undo()
    expect(Array.from(editor.bytes)).toEqual([0, 0, S, 0, 0, S, 0, 0])
    expect(store.get().edit.redoDepth).toBe(1)
    editor.redo()
    expect(editor.bytes[2]).toBe(H)
  })
  it('pick miss in replace mode clears; no-op ops leave the undo depth alone', () => {
    const { store, editor } = setup()
    editor.pick(1, 'replace'); editor.pick(null, 'replace')
    expect(store.get().edit.counts.selected).toBe(0)
    expect(store.get().edit.undoDepth).toBe(2)
    editor.del()                       // nothing selected
    expect(store.get().edit.undoDepth).toBe(2)
  })
  it('split tags sides by the fitted plane and side filter drives delete', () => {
    const { store, editor } = setup()
    for (let i = 0; i < 8; i++) editor.pick(i, 'add')
    editor.split()                     // threshold 2 × spacing = 70 m → all inliers; PCA normal ≈ z through the centroid (z = 50): 4 above, 4 below
    const bytes = Array.from(editor.bytes)
    const a = bytes.filter((f) => f & A).length, b = bytes.filter((f) => f & B).length
    expect(a).toBe(4); expect(b).toBe(4)
    expect(store.get().edit.split.fitted).toBe(true)
    store.set({ edit: { ...store.get().edit, splitSide: 'A' } })
    editor.del()
    expect(store.get().edit.counts.deleted).toBe(a)
    expect(store.get().edit.counts.selected).toBe(b)
  })
  it('split with < 3 selected sets a message and no tags', () => {
    const { store, editor } = setup()
    editor.pick(0, 'add'); editor.split()
    expect(store.get().edit.message).toMatch(/3/)
    expect(store.get().edit.split.fitted).toBe(false)
  })
  it('ops are ignored while busy; endGpuEdit recounts', () => {
    const { store, editor } = setup()
    editor.beginGpuEdit()
    expect(store.get().edit.busy).toBe(true)
    editor.pick(0, 'add')
    expect(store.get().edit.counts.selected).toBe(0)
    editor.bytes[3] = S                // "readback" landed
    editor.endGpuEdit()
    expect(store.get().edit).toMatchObject({ busy: false, counts: { selected: 1, hidden: 0, deleted: 0 }, undoDepth: 1 })
    editor.undo()
    expect(editor.bytes[3]).toBe(0)
  })
})
```

Add to `undo.test.ts`:

```ts
  it('dropLast removes the newest command and its bytes', () => {
    const b = new Uint8Array(4)
    const ring = createUndoRing(b)
    ring.push(0, 3); ring.dropLast()
    expect(ring.undoDepth()).toBe(0); expect(ring.bytes()).toBe(0)
  })
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

`undo.ts` — add `dropLast()` to the interface and object: `dropLast() { const c = undo.pop(); if (c) total -= c.flags.length }`.

`src/viewer/edit/editor.ts`:

```ts
import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import type { SelectMode, Store, ViewerState } from '../state/store'
import { dequantScale } from '../format/quant'
import { spacingOf } from '../compute/params'
import { countFlags, selectionRange, unionRange, FLAG_SELECTED, type Range } from './flags'
import { createUndoRing } from './undo'
import * as ops from './ops'
import { fitPlane, samplePoints, signedDistance } from './plane'

export interface Editor {
  bytes: Uint8Array
  isolate(): void; hide(): void; del(): void; unhideAll(): void; clearSelection(): void
  split(): void
  pick(idx: number | null, mode: SelectMode): void
  beginGpuEdit(): void
  endGpuEdit(): void
  undo(): void; redo(): void
  refresh(): void
  dispose(): void
}

const PLANE_SAMPLE_CAP = 50_000
const PLANE_THRESHOLD_MUL = 2          // inlier threshold = 2 × mean spacing (spec)

export function createEditor(buffers: PointBuffers, manifest: Manifest, store: Store<ViewerState>): Editor {
  const bytes = buffers.flagBytes
  const N = buffers.count
  const undo = createUndoRing(bytes)
  const dq = dequantScale(manifest.bounds)
  let selRange: Range | null = null
  const patch = (p: Partial<ViewerState['edit']>) => store.set({ edit: { ...store.get().edit, ...p } })
  const busy = () => store.get().edit.busy
  const side = () => store.get().edit.splitSide

  const refresh = () => {
    selRange = selectionRange(bytes)
    patch({ counts: countFlags(bytes), undoDepth: undo.undoDepth(), redoDepth: undo.redoDepth() })
  }
  // Whole-buffer ops: push N bytes first, drop the command again if nothing changed.
  const run = (pushRange: Range, op: () => Range | null) => {
    if (busy()) return
    undo.push(pushRange.min, pushRange.max)
    const r = op()
    if (!r) { undo.dropLast(); return }
    buffers.uploadFlagsRange(r.min, r.max)
    refresh()
  }
  const all: Range = { min: 0, max: N - 1 }
  const clearSel = () => { if (selRange) run(selRange, () => ops.clearSelection(bytes, selRange)) }

  // Bounds-relative positions of the selected points (same frame as the compute kernels), stride-sampled.
  const selectedPositions = () => {
    const idx: number[] = []
    for (let i = 0; i < N; i++) if (bytes[i] & FLAG_SELECTED) idx.push(i)
    const q = buffers.qpos.array as Uint32Array
    const pts = new Float32Array(idx.length * 3)
    idx.forEach((i, k) => {
      const w0 = q[i * 2], w1 = q[i * 2 + 1]
      pts[k * 3] = (w0 & 0xffff) * dq[0]; pts[k * 3 + 1] = (w0 >>> 16) * dq[1]; pts[k * 3 + 2] = (w1 & 0xffff) * dq[2]
    })
    return { pts, n: idx.length }
  }

  return {
    bytes,
    isolate: () => run(all, () => ops.isolate(bytes, side())),
    hide: () => run(all, () => ops.hide(bytes, side())),
    del: () => run(all, () => ops.del(bytes, side())),
    unhideAll: () => run(all, () => ops.unhideAll(bytes)),
    clearSelection: clearSel,
    pick(idx, mode) {
      if (idx === null) { if (mode === 'replace') clearSel(); return }
      const r = unionRange(mode === 'replace' ? selRange : null, { min: idx, max: idx })!
      run(r, () => ops.applyPick(bytes, idx, mode, selRange))
    },
    split() {
      if (busy()) return
      const sel = selectedPositions()
      if (sel.n < 3) { patch({ message: 'Split needs at least 3 selected points.', split: { fitted: false, inlierRatio: null } }); return }
      const sample = samplePoints(sel.pts, sel.n, PLANE_SAMPLE_CAP)
      const plane = fitPlane(sample.pts, sample.n, PLANE_THRESHOLD_MUL * spacingOf(manifest.bounds, manifest.pointCount))
      if (!plane) { patch({ message: 'Plane fit failed (degenerate selection).', split: { fitted: false, inlierRatio: null } }); return }
      const q = buffers.qpos.array as Uint32Array
      const sideA = (i: number) => {
        const w0 = q[i * 2], w1 = q[i * 2 + 1]
        return signedDistance(plane, (w0 & 0xffff) * dq[0], (w0 >>> 16) * dq[1], (w1 & 0xffff) * dq[2]) >= 0
      }
      run(all, () => ops.tagSplit(bytes, sideA))
      patch({ message: undefined, split: { fitted: true, inlierRatio: plane.inlierRatio } })
    },
    beginGpuEdit() { undo.push(0, N - 1); patch({ busy: true }) },
    endGpuEdit() { patch({ busy: false }); refresh() },
    undo() { if (busy()) return; const r = undo.undo(); if (r) { buffers.uploadFlagsRange(r.min, r.max); refresh() } },
    redo() { if (busy()) return; const r = undo.redo(); if (r) { buffers.uploadFlagsRange(r.min, r.max); refresh() } },
    refresh,
    dispose() { undo.clear() },
  }
}
```

The `split()` test: threshold `2 × sqrt(100 × 100 / 8) ≈ 70 m` makes every point an inlier, so the PCA plane passes through the centroid (z = 50) with the smallest-variance axis z (x spread 85, y 40, z 2); the ±1 m layers land on opposite sides, 4 each. Which layer is A depends on the RANSAC hypothesis orientation — the test asserts counts only.

`pointMaterial.ts` — after `collapsed`:

```ts
  const bitF = (bit: number) => float(fbyte.bitAnd(uint(bit))).div(bit)                   // 0 or 1, branchless
  const tint = vertexStage(vec3(bitF(FLAG_SELECTED), bitF(FLAG_SPLIT_A), bitF(FLAG_SPLIT_B)))
  const cSel = uniform(new THREE.Color('#bf1656')), cA = uniform(new THREE.Color('#2ec4b6')), cB = uniform(new THREE.Color('#ff9f1c'))
```
and replace the `colorNode` line:
```ts
  const base = mix(lutNode.mul(vertexStage(light)), vertexStage(abs(normalObj)), debugNormals)
  const highlighted = mix(mix(mix(base, cSel, tint.x.mul(0.7)), cA, tint.y), cB, tint.z)
  material.colorNode = highlighted
```
plus `setHighlight: (c) => { if (c.selected) cSel.value.set(c.selected); if (c.splitA) cA.value.set(c.splitA); if (c.splitB) cB.value.set(c.splitB) }` on the handle and interface. Import `FLAG_SELECTED, FLAG_SPLIT_A, FLAG_SPLIT_B`. `uniform(Color)` values are linear-space; the hex strings are sRGB — `new THREE.Color('#…')` converts to linear under the default `ColorManagement.enabled`, which is what the LUT path (sRGB textures decoded on sample) already produces, so the tint matches.

`ChunkSprites.tsx` — one effect reading the theme accent from the nearest root token:
```ts
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-pcv-root]')
    const accent = el ? getComputedStyle(el).getPropertyValue('--pcv-accent').trim() : ''
    if (accent) handle.setHighlight({ selected: accent })
  }, [handle])
```
and add `data-pcv-root` to the root `<div>` in `PointCloudViewer.tsx`. (`document.querySelector` inside `<Canvas>` is fine; the viewer root is an ancestor of the canvas. With several viewers on a page the first root wins — accept, note in ARCHITECTURE.)

`useLoader.ts` — `Loaded.editor: Editor`; create `createEditor(buffers, manifest, store)` next to `handle`; `dispose()` it in the cleanup effect.

- [ ] **Step 4: Run all tests, tsc, build.** `npx vitest run && npx tsc --noEmit && npm run build`.

- [ ] **Step 5: Browser check (manual highlight)** — `npm run dev`, Playwright: navigate `http://localhost:5173/`, `browser_wait_for` text `2,000,000/2,000,000`. Expose a temporary DEV handle in `useLoader` next to `__pcvBench`: `window.__pcvEdit = { editor, buffers }` (kept — Task 6 extends it). Evaluate:
  ```js
  const { editor } = window.__pcvEdit; for (let i = 0; i < 2e6; i += 2) editor.bytes[i] |= 2; editor.refresh(); window.__pcvEdit.buffers.uploadFlagsRange(0, 1999999); 'ok'
  ```
  Screenshot: every other point tinted with the accent. Then `editor.hide()` → half the points vanish, HUD `tris` unchanged (count is instances; hidden quads collapse). `editor.undo()` → they return. Console 0 errors. Record the screenshot names in the task notes.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "edit: editor glue (ops+undo+split+counts), selected/split tint in the vertex stage"`

### Task 6: GPU pick + lasso kernels, select pipeline, `EditRunner`

**Files:**
- Create: `src/viewer/compute/wgsl/select.ts`, `src/viewer/edit/selectPipeline.ts`, `src/viewer/edit/EditRunner.tsx`
- Modify: `src/viewer/render/Scene.tsx` (mount `<EditRunner>`, `ViewerApi.pick/lasso`), `src/viewer/loader/useLoader.ts` (`__pcvEdit` handle grows)
- Test: none in vitest (GPU); browser spike + acceptance below.

**Interfaces:**
- Consumes: `PointBuffers` (`qposNode`, `flagsNode`, `flags`, `count`), `timedCompute`, `helpers` (`pcvDecodePos`), `homePose`, `Editor`, `packPoly/polyBounds/MAX_LASSO_VERTS`, `cpuPick/cpuLasso`.
- Produces `compute/wgsl/select.ts`: `resetPick`, `pickDepth`, `pickIndex`, `lassoSelect` (`wgslFn`s) + a shared `selectHelpers` `wgsl()` block with `pcvProject(p: vec3<f32>, viewProj: mat4x4<f32>, viewport: vec2<f32>) -> vec4<f32>` (`xy` = screen px, `z` = depth, `w` = clip w; callers skip `w <= 0`), `pcvVisibleEnd(chunkTable, chunks, i) -> u32` (binary search: last chunk with `offset <= i`, returns its `y`), `pcvInPoly(px, poly, count) -> bool`. The helpers take the storage pointers as parameters (a kernel forwards its own `ptr<storage, …>` params); if the WGSL compiler rejects pointer forwarding, inline the two helpers into the kernels — note the outcome in ARCHITECTURE.
- Produces `edit/selectPipeline.ts`:
  ```ts
  interface SelectPipeline {
    pick(x: number, y: number, view: ViewParams): Promise<{ index: number | null; ms: number }>
    lasso(poly: Float32Array, count: number, mode: SelectMode, view: ViewParams): Promise<{ gpuMs: number | null; readbackMs: number }>   // flags GPU→mirror copied before resolve
    dispose(): void
  }
  interface ViewParams { viewProj: THREE.Matrix4; view: THREE.Matrix4; width: number; height: number; pointSize: number; refDist: number; budget: number }
  createSelectPipeline(renderer, buffers, manifest): SelectPipeline
  ```
- Produces on `ViewerApi`: `pick?: (x: number, y: number, mode: SelectMode) => Promise<void>`, `lasso?: (poly: [number, number][], mode: SelectMode) => Promise<void>` (both apply to the editor and update `edit.pickMs` / `edit.lasso`), `cpuPick?: (x: number, y: number) => number | null`, `cpuLasso?: (poly: [number, number][]) => Uint32Array` (DEV reference), `viewSize?: () => { width: number; height: number }`.

- [ ] **Step 1: Kernels** — `src/viewer/compute/wgsl/select.ts`:

```ts
import { wgsl, wgslFn } from 'three/tsl'
import { helpers } from './helpers'
import { MAX_LASSO_VERTS } from '../../edit/lasso'

// Shared prologue for the pick/lasso family: world = q * dqScale + dqMinCentred (the material's frame), clip = viewProj * world,
// screen px from the CSS viewport. Mirrors edit/project.ts (projectPoint / pointInPolygon) exactly.
export const selectHelpers = wgsl(/* wgsl */ `
fn pcvProject(p: vec3<f32>, viewProj: mat4x4<f32>, viewport: vec2<f32>) -> vec4<f32> {
  let c = viewProj * vec4<f32>(p, 1.0);
  let ndc = c.xy / c.w;
  return vec4<f32>((ndc.x * 0.5 + 0.5) * viewport.x, (0.5 - ndc.y * 0.5) * viewport.y, c.z / c.w, c.w);
}
// chunkTable[c] = (offset, visibleEnd); the point's chunk is the last entry with offset <= i.
fn pcvVisibleEnd(chunkTable: ptr<storage, array<vec2<u32>>, read_write>, chunks: u32, i: u32) -> u32 {
  var lo = 0u; var hi = chunks;
  while (hi - lo > 1u) { let mid = (lo + hi) / 2u; if (chunkTable[mid].x <= i) { lo = mid; } else { hi = mid; } }
  return chunkTable[lo].y;
}
fn pcvInPoly(px: vec2<f32>, poly: ptr<storage, array<vec2<f32>>, read_write>, count: u32) -> bool {
  var inside = false;
  var j = count - 1u;
  for (var i = 0u; i < count; i++) {
    let a = poly[i]; let b = poly[j];
    if ((a.y > px.y) != (b.y > px.y) && px.x < (b.x - a.x) * (px.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
    j = i;
  }
  return inside;
}
`)

export const resetPick = wgslFn(/* wgsl */ `
  fn resetPick(pick: ptr<storage, array<atomic<u32>>, read_write>, i: u32) -> u32 {
    if (i < 2u) { atomicStore(&pick[i], 0xffffffffu); }
    return 0u;
  }
`)

// Pass 1: min depth bits among visible points within r px of the cursor. Depth in [0,1] is a non-negative f32, so
// bitcast<u32> orders like the value. r = max(3, attenuated size px) — the same size the material renders.
export const pickDepth = wgslFn(/* wgsl */ `
  fn pickDepth(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
               chunkTable: ptr<storage, array<vec2<u32>>, read_write>, pick: ptr<storage, array<atomic<u32>>, read_write>,
               i: u32, count: u32, chunks: u32, dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, view: mat4x4<f32>,
               viewport: vec2<f32>, cursor: vec2<f32>, pointSize: f32, refDist: f32) -> u32 {
    if (i >= count) { return 0u; }
    if (i >= pcvVisibleEnd(chunkTable, chunks, i)) { return 0u; }
    let f = (flags[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
    if ((f & 5u) != 0u) { return 0u; }                       // hidden | deleted
    let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
    let s = pcvProject(p, viewProj, viewport);
    if (s.w <= 0.0 || s.z < 0.0 || s.z > 1.0) { return 0u; }
    let viewZ = (view * vec4<f32>(p, 1.0)).z;
    let r = max(3.0, clamp(pointSize * refDist / -viewZ, 1.0, 8.0));
    let d = s.xy - cursor;
    if (dot(d, d) > r * r) { return 0u; }
    atomicMin(&pick[0], bitcast<u32>(s.z));
    return 1u;
  }
`, [helpers, selectHelpers])

// Pass 2: lowest index at exactly that depth (same expression → bit-identical).
export const pickIndex = wgslFn(/* wgsl */ `
  fn pickIndex(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
               chunkTable: ptr<storage, array<vec2<u32>>, read_write>, pick: ptr<storage, array<atomic<u32>>, read_write>,
               i: u32, count: u32, chunks: u32, dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, view: mat4x4<f32>,
               viewport: vec2<f32>, cursor: vec2<f32>, pointSize: f32, refDist: f32) -> u32 {
    if (i >= count) { return 0u; }
    if (i >= pcvVisibleEnd(chunkTable, chunks, i)) { return 0u; }
    let f = (flags[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
    if ((f & 5u) != 0u) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
    let s = pcvProject(p, viewProj, viewport);
    if (s.w <= 0.0 || s.z < 0.0 || s.z > 1.0) { return 0u; }
    let viewZ = (view * vec4<f32>(p, 1.0)).z;
    let r = max(3.0, clamp(pointSize * refDist / -viewZ, 1.0, 8.0));
    let d = s.xy - cursor;
    if (dot(d, d) > r * r) { return 0u; }
    if (bitcast<u32>(s.z) == atomicLoad(&pick[0])) { atomicMin(&pick[1], i); }
    return 1u;
  }
`, [helpers, selectHelpers])

// Thread per word: read once, test 4 points, write the word back. mode 0 replace (clear selected everywhere,
// set inside), 1 add (OR inside), 2 subtract (AND-NOT inside). bbox = (minX, minY, maxX, maxY) screen px.
export const lassoSelect = wgslFn(/* wgsl */ `
  fn lassoSelect(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
                 chunkTable: ptr<storage, array<vec2<u32>>, read_write>, poly: ptr<storage, array<vec2<f32>>, read_write>,
                 w: u32, count: u32, chunks: u32, vertexCount: u32, mode: u32, bbox: vec4<f32>,
                 dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, viewport: vec2<f32>) -> u32 {
    if (w * 4u >= count) { return 0u; }
    var word = flags[w];
    for (var k = 0u; k < 4u; k++) {
      let i = w * 4u + k;
      if (i >= count) { break; }
      let shift = k * 8u;
      let f = (word >> shift) & 0xffu;
      var g = f;
      if (mode == 0u) { g = g & ~26u; }                      // replace: drop selected + split tags everywhere
      if ((f & 5u) == 0u && i < pcvVisibleEnd(chunkTable, chunks, i)) {
        let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
        let s = pcvProject(p, viewProj, viewport);
        if (s.w > 0.0 && s.z >= 0.0 && s.z <= 1.0 && s.x >= bbox.x && s.x <= bbox.z && s.y >= bbox.y && s.y <= bbox.w
            && pcvInPoly(s.xy, poly, vertexCount)) {
          if (mode == 2u) { g = g & ~2u; } else { g = g | 2u; }
        }
      }
      if (mode == 2u && (g & 2u) == 0u) { g = g & ~24u; }       // dropped from the selection → drop split tags too
      word = (word & ~(0xffu << shift)) | (g << shift);
    }
    flags[w] = word;
    return word;
  }
`, [helpers, selectHelpers])

export const LASSO_POLY_WORDS = MAX_LASSO_VERTS * 2
```

- [ ] **Step 2: Pipeline** — `src/viewer/edit/selectPipeline.ts`:

```ts
import * as THREE from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, uniform, vec2, vec3, vec4, type wgslFn } from 'three/tsl'
import type { PointBuffers } from '../render/PointBuffers'
import { centroidOf, type Manifest } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import type { SelectMode } from '../state/store'
import { timedCompute } from '../compute/timing'
import { resetPick, pickDepth, pickIndex, lassoSelect, LASSO_POLY_WORDS } from '../compute/wgsl/select'
import { polyBounds, MAX_LASSO_VERTS } from './lasso'

export interface ViewParams { viewProj: THREE.Matrix4; view: THREE.Matrix4; width: number; height: number; pointSize: number; refDist: number; budget: number }
export interface SelectPipeline {
  pick(x: number, y: number, v: ViewParams): Promise<{ index: number | null; ms: number }>
  lasso(poly: Float32Array, count: number, mode: SelectMode, v: ViewParams): Promise<{ gpuMs: number | null; readbackMs: number }>
  dispose(): void
}

type Kernel = ReturnType<typeof wgslFn>
const call = (fn: Kernel, args: Record<string, Node | number>) => (fn(args as Parameters<Kernel>[0]) as Node<'uint'>).toVar()
const MODE: Record<SelectMode, number> = { replace: 0, add: 1, subtract: 2 }
const MISS = 0xffffffff

export function createSelectPipeline(renderer: THREE.WebGPURenderer, buffers: PointBuffers, manifest: Manifest): SelectPipeline {
  const N = buffers.count, words = Math.ceil(N / 4), chunks = manifest.chunks.length
  const b = manifest.bounds, c = centroidOf(b)
  const pickAttr = new THREE.StorageBufferAttribute(new Uint32Array(2), 1)
  const polyAttr = new THREE.StorageBufferAttribute(new Float32Array(LASSO_POLY_WORDS), 2)
  const chunkAttr = new THREE.StorageBufferAttribute(new Uint32Array(chunks * 2), 2)
  const pick = storage(pickAttr, 'uint', 2).toAtomic() as StorageBufferNode<'uint'>
  const poly = storage(polyAttr, 'vec2', MAX_LASSO_VERTS)
  const chunkTable = storage(chunkAttr, 'uvec2', chunks)
  const u = {
    viewProj: uniform(new THREE.Matrix4()), view: uniform(new THREE.Matrix4()),
    viewport: uniform(new THREE.Vector2()), cursor: uniform(new THREE.Vector2()),
    pointSize: uniform(2), refDist: uniform(1000), vertexCount: uniform(0, 'uint'), mode: uniform(0, 'uint'), bbox: uniform(new THREE.Vector4()),
  }
  const common = {
    qpos: buffers.qposNode, flags: buffers.flagsNode, chunkTable, count: uint(N), chunks: uint(chunks),
    dqScale: vec3(...dequantScale(b)), dqMin: vec3(b.min[0] - c[0], b.min[1] - c[1], b.min[2] - c[2]),
    viewProj: u.viewProj, viewport: u.viewport,
  }
  const pickArgs = { ...common, pick, view: u.view, cursor: u.cursor, pointSize: u.pointSize, refDist: u.refDist, i: instanceIndex }
  const kReset = Fn(() => call(resetPick, { pick, i: instanceIndex }))().compute(2, [1])
  const kDepth = Fn(() => call(pickDepth, pickArgs))().compute(N, [64])
  const kIndex = Fn(() => call(pickIndex, pickArgs))().compute(N, [64])
  const kLasso = Fn(() => call(lassoSelect, { ...common, poly, w: instanceIndex, vertexCount: u.vertexCount, mode: u.mode, bbox: u.bbox }))().compute(words, [64])

  const setView = (v: ViewParams) => {
    u.viewProj.value.copy(v.viewProj); u.view.value.copy(v.view)
    u.viewport.value.set(v.width, v.height); u.pointSize.value = v.pointSize; u.refDist.value = v.refDist
    const t = chunkAttr.array as Uint32Array
    manifest.chunks.forEach((ch, k) => { t[k * 2] = ch.offset; t[k * 2 + 1] = ch.offset + Math.ceil(ch.count * v.budget) })
    chunkAttr.needsUpdate = true
  }

  return {
    async pick(x, y, v) {
      const t0 = performance.now()
      setView(v); u.cursor.value.set(x, y)
      await renderer.computeAsync(kReset)
      await renderer.computeAsync(kDepth)
      await renderer.computeAsync(kIndex)
      const out = new Uint32Array(await renderer.getArrayBufferAsync(pickAttr))
      return { index: out[1] === MISS ? null : out[1], ms: performance.now() - t0 }
    },
    async lasso(polyData, count, mode, v) {
      setView(v)
      ;(polyAttr.array as Float32Array).set(polyData); polyAttr.needsUpdate = true
      u.vertexCount.value = count; u.mode.value = MODE[mode]
      const [minX, minY, maxX, maxY] = polyBounds(polyData, count); u.bbox.value.set(minX, minY, maxX, maxY)
      const { gpuMs } = await timedCompute(renderer, kLasso, 'lasso')
      const t0 = performance.now()
      const buf = await renderer.getArrayBufferAsync(buffers.flags)
      ;(buffers.flags.array as Uint32Array).set(new Uint32Array(buf))      // mirror ← GPU; no needsUpdate (A5)
      return { gpuMs, readbackMs: performance.now() - t0 }
    },
    dispose() { for (const n of [pick, poly, chunkTable, kReset, kDepth, kIndex, kLasso]) n.dispose() },
  }
}
```

`uniform(0, 'uint')` — check the TSL signature in `@types/three` (`uniform(value, type?)`); if the type argument is not accepted, use `uniform(uint(0))`.

- [ ] **Step 3: EditRunner** — `src/viewer/edit/EditRunner.tsx`:

```tsx
import { useEffect, useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import { homePose, type ViewerApi } from '../render/Scene'
import { useStore, useViewerStore, type EditState } from '../state/store'
import type { Editor } from './editor'
import { createSelectPipeline, type ViewParams } from './selectPipeline'
import { packPoly } from './lasso'

// Inside <Canvas>: owns the GPU select pipeline, exposes api.pick/api.lasso, disables OrbitControls in lasso mode.
export function EditRunner({ buffers, manifest, editor, api }: { buffers: PointBuffers; manifest: Manifest; editor: Editor; api: ViewerApi }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null
  const store = useViewerStore()
  const tool = useStore((s) => s.edit.tool)

  useEffect(() => { if (controls) controls.enabled = tool === 'orbit' }, [controls, tool])

  useLayoutEffect(() => {
    const p = createSelectPipeline(gl as unknown as THREE.WebGPURenderer, buffers, manifest)
    const canvas = (gl as unknown as THREE.WebGPURenderer).domElement
    const view = (): ViewParams => {
      camera.updateMatrixWorld()
      const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      return { viewProj, view: camera.matrixWorldInverse.clone(), width: canvas.clientWidth, height: canvas.clientHeight,
        pointSize: store.get().pointSize, refDist: homePose(manifest, camera.fov).dist, budget: store.get().budget }
    }
    const patch = (e: Partial<EditState>) => store.set({ edit: { ...store.get().edit, ...e } })
    api.viewSize = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
    api.pick = async (x, y, mode) => {
      if (store.get().edit.busy) return
      patch({ busy: true })
      try { const r = await p.pick(x, y, view()); patch({ busy: false, pickMs: r.ms }); editor.pick(r.index, mode) }
      catch (err) { patch({ busy: false, message: String(err) }) }
    }
    api.lasso = async (polyPx, mode) => {
      if (store.get().edit.busy) return
      const { data, count } = packPoly(polyPx)
      if (count < 3) return
      editor.beginGpuEdit()
      try {
        const r = await p.lasso(data, count, mode, view())
        editor.endGpuEdit()
        patch({ lasso: { gpuMs: r.gpuMs, readbackMs: r.readbackMs, selected: store.get().edit.counts.selected } })
      } catch (err) { editor.endGpuEdit(); patch({ message: String(err) }) }
    }
    return () => { api.pick = undefined; api.lasso = undefined; api.viewSize = undefined; p.dispose() }
  }, [gl, camera, buffers, manifest, editor, api, store])
  return null
}
```
Mount `<EditRunner buffers manifest editor api />` in `Scene` (add `editor: Editor` to `Scene` props; `PointCloudViewer` passes `loaded.editor`). Add the four optional members to `ViewerApi`.

DEV reference in `useLoader` (extend `__pcvEdit`): `cpuPick(x, y)` and `cpuLasso(poly)` built from `cpuPick`/`cpuLasso` (`edit/project.ts`) over `buffers.qpos.array`, `dequantScale`, `dqMin = bounds.min − centroid`, `viewProj` from the live camera — expose `api.viewParams = view` from `EditRunner` (DEV only) so the CPU reference uses the identical matrices, viewport and `visible(i)` (= not hidden/deleted and inside the budget prefix, computed from `manifest.chunks` and `store.budget`), and `radiusPx(i)` = `max(3, clamp(pointSize × refDist / −viewZ(i), 1, 8))` with `viewZ(i)` = `(view × world(i)).z` (4 multiplies from `decodeWorld` + the `view` matrix).

- [ ] **Step 4: Spike — kernels compile and picks are fresh.** `npm run dev`; Playwright: navigate, wait for load. Evaluate:
  ```js
  const c = document.querySelector('canvas'); const w = c.clientWidth, h = c.clientHeight
  await window.__pcvEdit.api.pick(w/2, h/2, 'replace'); const a = window.__pcvEdit.editor.bytes.findIndex(f => f & 2)
  await window.__pcvEdit.api.pick(w*0.3, h*0.6, 'replace'); const b = window.__pcvEdit.editor.bytes.findIndex(f => f & 2)
  ({ a, b, pickMs: window.__pcvEdit.state().pickMs })
  ```
  Expected: `a !== b`, both ≥ 0 (or one `-1` if a spot is empty — pick another), no console errors. If `mat4x4<f32>` params fail to compile, the fallback is four `vec4` uniforms (columns) rebuilt into a `mat4x4<f32>(c0, c1, c2, c3)` inside the kernel. If `atomicMin` fails, use `atomicFunc('atomicMin', …)` from `three/tsl` in a TSL wrapper — record whichever happened in ARCHITECTURE.

- [ ] **Step 5: Acceptance — GPU pick vs CPU reference, 20 cursors.** Evaluate (one in-page loop, demo set, budget 100 %):
  ```js
  const c = document.querySelector('canvas'); const w = c.clientWidth, h = c.clientHeight
  const E = window.__pcvEdit; let agree = 0, miss = 0, rows = []
  for (let k = 0; k < 20; k++) {
    const x = Math.round(w * (0.2 + 0.6 * ((k * 37) % 20) / 20)), y = Math.round(h * (0.2 + 0.6 * ((k * 53) % 20) / 20))
    await E.api.pick(x, y, 'replace'); const gpu = E.editor.bytes.findIndex(f => f & 2); const g = gpu < 0 ? null : gpu
    const cpu = E.cpuPick(x, y)
    const same = g === cpu || (g !== null && cpu !== null && E.depthOf(g) === E.depthOf(cpu))
    if (same) agree++; if (cpu === null) miss++; rows.push([x, y, g, cpu, same])
  }
  ({ agree, miss, rows })
  ```
  (`depthOf(i)` = CPU projected depth via `projectPoint`, exposed on `__pcvEdit` for ties.) Expected: `agree === 20`. If disagreements are all at f32-vs-f64 depth ties or at the radius boundary (distance within 0.5 px of `r`), relax the comparison to "CPU depth of the GPU pick ≤ CPU best depth + 1e-6 and GPU pick within r + 0.5 px" and document; a systematic offset means `viewport`/`cursor` conventions differ (check `clientWidth` vs DPR).
  Also run one pick at `budget = 0.5` (`store.set({ budget: 0.5 })` via `E.store`) and confirm the picked index is inside its chunk's visible prefix.

- [ ] **Step 6: Lasso timing + readback, 2M then 20M.** Evaluate:
  ```js
  const c = document.querySelector('canvas'); const w = c.clientWidth, h = c.clientHeight
  const poly = [[w*0.3,h*0.3],[w*0.7,h*0.3],[w*0.7,h*0.7],[w*0.3,h*0.7]]
  await window.__pcvEdit.api.lasso(poly, 'replace'); const s = window.__pcvEdit.state()
  const cpu = window.__pcvEdit.cpuLasso(poly).length
  ({ lasso: s.lasso, cpu })
  ```
  Expected 2M: `selected === cpu` (exact; if off by a handful, check edge-rule parity and f32 vs f64 at the boundary — report the count), console clean. Screenshot with the selection tinted. Then `?data=full` (use `browser_wait_for` on `20,000,000/20,000,000`, per CLAUDE.md): record `gpuMs` (acceptance < 20 ms) and `readbackMs` for the 20 MB flags readback (spec risk: if > 100 ms, note it; the partial-readback fallback via `getArrayBufferAsync(attr, null, offset, count)` — offsets multiple of 4 — is available but not required for this phase). Run add and subtract modes once each. Record all numbers in the task notes for Task 9.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "edit: GPU pick (atomicMin depth/index) + thread-per-word lasso, EditRunner, CPU references"`

### Task 7: Toolbar, lasso overlay, click pick, shortcuts

**Files:**
- Create: `src/viewer/ui/Toolbar.tsx`, `src/viewer/ui/Toolbar.module.css`, `src/viewer/ui/LassoOverlay.tsx`, `src/viewer/ui/LassoOverlay.module.css`
- Modify: `src/viewer/PointCloudViewer.tsx` (mount, pointer handling, keys), `src/viewer/ui/Overlays.tsx` (`KEYS`), `src/viewer/PointCloudViewer.module.css`
- Test: `src/viewer/ui/keys.test.ts` (pure key→action map)

**Interfaces:**
- Produces `ui/keys.ts` (pure, tested): `type EditAction = 'lasso' | 'escape' | 'isolate' | 'hide' | 'delete' | 'unhideAll' | 'clearSelection' | 'split' | 'undo' | 'redo' | 'fit' | 'hud'`; `keyAction(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): EditAction | null`.
- `Toolbar({ editor, api })`: tool toggle (Orbit / Lasso), `Isolate`, `Hide`, `Delete`, `Unhide all`, `Clear`, `Split`, side `<select>` (All / A / B, enabled after a split), `Undo`, `Redo`, `Export` (wired in Task 8; disabled until then), a counts line `sel N · hidden N · deleted N`, and `edit.message` / lasso timing line (`lasso 12.3 ms gpu · 45 ms readback`). Buttons disabled while `edit.busy` or `status !== 'ready'`; op buttons also when `counts.selected === 0` (except Unhide all / Clear).
- `LassoOverlay({ api })`: full-size `<svg>` over the canvas; `pointer-events: auto` only when `edit.tool === 'lasso'`. Pointerdown starts a polygon (capture pointer), pointermove appends (`simplifyPoly` at 2 px), pointerup with ≥ 3 vertices calls `api.lasso(poly, modeFrom(e))` (`shiftKey → 'add'`, `altKey → 'subtract'`, else `'replace'`); `Esc` clears the polygon in progress. Renders `<polygon>` with the accent stroke, dashed, semi-transparent fill.
- Click pick: root `onPointerDown` records `{x, y}` when `e.target` is a `<canvas>` and the tool is orbit; `onPointerUp` on the same target within 4 px → `api.pick(offsetX, offsetY, mode)`; coordinates relative to the canvas via `getBoundingClientRect()`.

- [ ] **Step 1: Failing test** — `src/viewer/ui/keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { keyAction } from './keys'

const k = (key: string, extra: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
  keyAction({ key, code: extra.code ?? '', metaKey: false, ctrlKey: false, shiftKey: false, ...extra })
describe('keyAction', () => {
  it('maps editing keys (H stays HUD, X hides)', () => {
    expect(k('l')).toBe('lasso'); expect(k('Escape')).toBe('escape'); expect(k('i')).toBe('isolate'); expect(k('X')).toBe('hide')
    expect(k('Delete')).toBe('delete'); expect(k('Backspace')).toBe('delete'); expect(k('u')).toBe('unhideAll')
    expect(k('c')).toBe('clearSelection'); expect(k('s')).toBe('split'); expect(k('f')).toBe('fit'); expect(k('h')).toBe('hud')
  })
  it('undo / redo need meta or ctrl; shift flips to redo', () => {
    expect(k('z')).toBeNull()
    expect(k('z', { metaKey: true })).toBe('undo'); expect(k('z', { ctrlKey: true })).toBe('undo')
    expect(k('z', { metaKey: true, shiftKey: true })).toBe('redo'); expect(k('Z', { ctrlKey: true, shiftKey: true })).toBe('redo')
  })
  it('modified letters are not actions', () => { expect(k('i', { metaKey: true })).toBeNull() })
})
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

`src/viewer/ui/keys.ts`:

```ts
export type EditAction = 'lasso' | 'escape' | 'isolate' | 'hide' | 'delete' | 'unhideAll' | 'clearSelection' | 'split' | 'undo' | 'redo' | 'fit' | 'hud'

const LETTERS: Record<string, EditAction> = { l: 'lasso', i: 'isolate', x: 'hide', u: 'unhideAll', c: 'clearSelection', s: 'split', f: 'fit', h: 'hud' }

export function keyAction(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): EditAction | null {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  if (mod) return key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : null
  if (e.key === 'Escape') return 'escape'
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  return LETTERS[key] ?? null
}
```

`PointCloudViewer.tsx` — replace the `onKeyDown` body:

```tsx
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.code === 'Backslash') { if (!e.repeat) setShowKeys(true); e.preventDefault(); return }
    const action = keyAction(e)
    if (!action) return
    const editor = loaded?.editor
    const setTool = (tool: EditTool) => store.set({ edit: { ...store.get().edit, tool } })
    switch (action) {
      case 'fit': api.fit(); break
      case 'hud': store.set({ showHud: !store.get().showHud }); break
      case 'lasso': setTool(store.get().edit.tool === 'lasso' ? 'orbit' : 'lasso'); break
      case 'escape': setTool('orbit'); break
      case 'isolate': editor?.isolate(); break
      case 'hide': editor?.hide(); break
      case 'delete': editor?.del(); break
      case 'unhideAll': editor?.unhideAll(); break
      case 'clearSelection': editor?.clearSelection(); break
      case 'split': editor?.split(); break
      case 'undo': editor?.undo(); break
      case 'redo': editor?.redo(); break
    }
    e.preventDefault()
  }
```

Pointer pick on the root:

```tsx
  const down = useRef<{ x: number; y: number } | null>(null)
  const canvasPos = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.tagName !== 'CANVAS') return null
    const r = t.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => { down.current = store.get().edit.tool === 'orbit' ? canvasPos(e) : null }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = down.current; down.current = null
    const p = canvasPos(e)
    if (!d || !p || Math.hypot(p.x - d.x, p.y - d.y) > 4) return
    void api.pick?.(p.x, p.y, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace')
  }
```
Attach both to the root `<div>`; mount `<Toolbar editor={loaded?.editor ?? null} api={api} />` and `<LassoOverlay api={api} />` (overlay only when `loaded`), add `data-pcv-root`.

`LassoOverlay.tsx`:

```tsx
import { useRef, useState, type PointerEvent } from 'react'
import type { ViewerApi } from '../render/Scene'
import { useStore, useViewerStore } from '../state/store'
import { simplifyPoly, type Poly } from '../edit/lasso'
import styles from './LassoOverlay.module.css'

export function LassoOverlay({ api }: { api: ViewerApi }) {
  const store = useViewerStore()
  const tool = useStore((s) => s.edit.tool)
  const [poly, setPoly] = useState<Poly>([])
  const drawing = useRef(false)
  const local = (e: PointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const onDown = (e: PointerEvent<SVGSVGElement>) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); setPoly([local(e)]) }
  const onMove = (e: PointerEvent<SVGSVGElement>) => { if (drawing.current) setPoly((p) => simplifyPoly([...p, local(e)], 2)) }
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    drawing.current = false
    const done = simplifyPoly([...poly, local(e)], 2)
    setPoly([])
    if (done.length >= 3) void api.lasso?.(done, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace')
  }
  if (tool !== 'lasso') return null
  return (
    <svg className={styles.overlay} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={() => { drawing.current = false; setPoly([]) }} onDoubleClick={() => store.set({ edit: { ...store.get().edit, tool: 'orbit' } })}>
      {poly.length > 1 && <polygon className={styles.poly} points={poly.map((p) => p.join(',')).join(' ')} />}
    </svg>
  )
}
```
`LassoOverlay.module.css`: `.overlay { position: absolute; inset: 0; z-index: 1; cursor: crosshair; touch-action: none; }` `.poly { fill: color-mix(in srgb, var(--pcv-accent) 20%, transparent); stroke: var(--pcv-accent); stroke-width: 1.5; stroke-dasharray: 4 3; }`. `Esc` in lasso mode: the root key handler switches the tool, which unmounts the overlay and drops the polygon.

`Toolbar.tsx` (bottom-left card, same tokens as Panel; `Toolbar.module.css` with `.bar { position: absolute; left: 8px; bottom: 8px; z-index: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; background: var(--pcv-card); border: 1px solid var(--pcv-border); border-radius: var(--pcv-radius); font: 12px/1.5 var(--pcv-font); color: var(--pcv-text) }`, `.btn`, `.btn[data-active=true] { background: var(--pcv-accent); color: #fff }`, `.muted`, `.sep { width: 1px; height: 18px; background: var(--pcv-border) }`):

```tsx
import { useStore, useViewerStore, type SplitSide } from '../state/store'
import type { ViewerApi } from '../render/Scene'
import type { Editor } from '../edit/editor'
import styles from './Toolbar.module.css'

interface BtnProps { label: string; on: () => void; ready: boolean; disabled?: boolean; active?: boolean; title?: string }
// Module-level so React keeps the button identity across renders (a per-render component would remount on every store change).
function Btn({ label, on, ready, disabled, active, title }: BtnProps) {
  return <button className={styles.btn} data-active={active} disabled={!ready || disabled} onClick={on} title={title}>{label}</button>
}

export function Toolbar({ editor, api }: { editor: Editor | null; api: ViewerApi }) {
  const store = useViewerStore()
  const edit = useStore((s) => s.edit)
  const status = useStore((s) => s.status)
  const ready = status === 'ready' && !!editor && !edit.busy
  const hasSel = edit.counts.selected > 0
  const setEdit = (p: Partial<typeof edit>) => store.set({ edit: { ...store.get().edit, ...p } })
  return (
    <div className={styles.bar}>
      <Btn ready={ready} label="Orbit" active={edit.tool === 'orbit'} on={() => setEdit({ tool: 'orbit' })} title="Esc" />
      <Btn ready={ready} label="Lasso" active={edit.tool === 'lasso'} on={() => setEdit({ tool: 'lasso' })} title="L" />
      <span className={styles.sep} />
      <Btn ready={ready} label="Isolate" disabled={!hasSel} on={() => editor?.isolate()} title="I" />
      <Btn ready={ready} label="Hide" disabled={!hasSel} on={() => editor?.hide()} title="X" />
      <Btn ready={ready} label="Delete" disabled={!hasSel} on={() => editor?.del()} title="Delete" />
      <Btn ready={ready} label="Unhide all" disabled={edit.counts.hidden === 0} on={() => editor?.unhideAll()} title="U" />
      <Btn ready={ready} label="Clear" disabled={!hasSel} on={() => editor?.clearSelection()} title="C" />
      <span className={styles.sep} />
      <Btn ready={ready} label="Split" disabled={edit.counts.selected < 3} on={() => editor?.split()} title="S" />
      <select className={styles.select} value={edit.splitSide} disabled={!edit.split.fitted} onChange={(e) => setEdit({ splitSide: e.target.value as SplitSide })}>
        <option value="all">Both sides</option><option value="A">Side A</option><option value="B">Side B</option>
      </select>
      <span className={styles.sep} />
      <Btn ready={ready} label="Undo" disabled={edit.undoDepth === 0} on={() => editor?.undo()} title="⌘Z" />
      <Btn ready={ready} label="Redo" disabled={edit.redoDepth === 0} on={() => editor?.redo()} title="⇧⌘Z" />
      <Btn ready={ready} label="Export" disabled={!api.exportZip} on={() => void api.exportZip?.()} />
      <span className={styles.muted}>sel {edit.counts.selected.toLocaleString()} · hidden {edit.counts.hidden.toLocaleString()} · deleted {edit.counts.deleted.toLocaleString()}</span>
      {edit.lasso && <span className={styles.muted}>lasso {edit.lasso.gpuMs?.toFixed(2) ?? 'n/a'} ms gpu · {edit.lasso.readbackMs.toFixed(0)} ms readback</span>}
      {edit.pickMs !== null && <span className={styles.muted}>pick {edit.pickMs.toFixed(1)} ms</span>}
      {edit.message && <span className={styles.muted}>{edit.message}</span>}
    </div>
  )
}
```
Add `exportZip?: () => Promise<void>` to `ViewerApi` now (Task 8 fills it). Buttons must not steal focus from the root for keys: add `onMouseDown={(e) => e.preventDefault()}` on the bar so clicking a button keeps focus where it was (the root stays focused after the user clicked the canvas). Selected/split points remain visible after `Hide` only if not hidden — expected.

`Overlays.tsx` `KEYS` — replace with the full table: `drag / wheel`, `click / ⇧ / ⌥`, `F`, `H`, `L`, `Esc`, `I`, `X`, `Delete`, `U`, `C`, `S`, `⌘Z / ⇧⌘Z`, `\ (hold)`.

`PointCloudViewer.module.css`: nothing new (toolbar/overlay have their own modules). Ensure the r3f `<Canvas>` wrapper div is `position: absolute; inset: 0` (r3f sets `position: relative; width/height 100%` — the root is `position: relative`, so the SVG overlay at `inset: 0` covers the same box).

- [ ] **Step 4: Run tests, tsc, build.**

- [ ] **Step 5: Browser flow (Playwright, demo)** — navigate, wait for load, `browser_click` on the canvas centre (focus + pick) → toolbar shows `sel 1`, one accent point (screenshot `p5-pick.png`). `browser_press_key` `l` → crosshair overlay; `browser_drag` from (30 %, 30 %) to (70 %, 70 %) of the canvas — drag gives a 2-vertex path; instead use `browser_run_code_unsafe` to dispatch `pointerdown/move×4/up` on the `svg` around a square, or drive `api.lasso` directly for the count and use the real drag only to verify the overlay draws. Expect `sel` ≈ Task 6's count (screenshot `p5-lasso.png`). Press `s` → split colours (screenshot `p5-split.png`); side `A` + `Delete` → deleted count = side-A count; `Cmd+Z` twice restores (`sel` back, `deleted 0`); `i` isolates; `u` unhides. Press `h` → HUD toggles (unchanged behaviour). Console: 0 errors.
- [ ] **Step 6: Focus scoping** — `browser_evaluate`: `document.activeElement = document.body` (`document.body.focus()` after `document.querySelector('[data-pcv-root]').blur()`), then `browser_press_key` `Delete` with a selection present → counts unchanged. Click the canvas, `Delete` → deleted increments.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "ui: editing toolbar, lasso overlay, click pick, focus-scoped edit keys"`

### Task 8: Export (worker compaction + fflate zip + download + re-open)

**Files:**
- Create: `src/viewer/edit/export.ts`
- Modify: `src/viewer/loader/fetchChunks.ts` (`LoaderIn`/`LoaderOut`), `src/viewer/loader/loader.worker.ts`, `src/viewer/loader/useLoader.ts` (`api.exportZip`), `src/App.tsx` (`?data=<name>`)
- Test: `src/viewer/edit/export.test.ts`

**Interfaces:**
- Produces `edit/export.ts` (pure, worker-safe):
  `compactPoints(words: Uint32Array, flags: Uint8Array, n: number): { words: Uint32Array; count: number; qmin: [n,n,n]; qmax: [n,n,n] }` — keeps points whose `deleted` bit is clear, order preserved, preallocated output sized by a first counting pass; tracks quantized min/max;
  `exportManifest(src: Manifest, count: number, qmin, qmax): Manifest` — `version 1`, `name: src.name + ' (export)'`, `source: (src.source ?? '') + '#export'`, same `bounds`/`crs`/`license`/`classMap`/`units`/`bytesPerPoint`, `pointCount: count`, `file: 'points.bin'`, one chunk `{ offset: 0, count, bounds: dequantized qmin/qmax }`;
  `buildZip(words: Uint32Array, manifest: Manifest): Uint8Array` — `zipSync({ 'points.bin': [new Uint8Array(words.buffer, words.byteOffset, words.byteLength), { level: 0 }], 'manifest.json': strToU8(JSON.stringify(manifest)) })`.
- `LoaderIn` += `{ type: 'export'; words: Uint32Array; flags: Uint8Array; manifest: Manifest }`; `LoaderOut` += `{ type: 'exportDone'; zip: Uint8Array; count: number } | { type: 'exportError'; message: string }`.
- `ViewerApi.exportZip?: () => Promise<void>` — copies `qpos.array` (`slice()`) and `flagBytes` (`slice()`), posts with transfer, on `exportDone` creates a Blob → `<a download="export.zip">` click → `URL.revokeObjectURL`; sets `edit.busy` for the duration and `edit.message` = `exported N points`.

- [ ] **Step 1: Failing tests** — `src/viewer/edit/export.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { compactPoints, exportManifest, buildZip } from './export'
import { packWords, unpackWords } from '../format/quant'
import { validateManifest, type Manifest } from '../loader/manifest'
import { FLAG_DELETED, FLAG_HIDDEN } from './flags'

const src: Manifest = {
  version: 1, name: 'demo', source: 'tile', units: 'm', bounds: { min: [0, 0, 0], max: [10, 20, 30] }, pointCount: 4, bytesPerPoint: 8,
  file: 'points.bin', classMap: { '2': 'Ground' }, chunks: [{ offset: 0, count: 4, bounds: { min: [0, 0, 0], max: [10, 20, 30] } }],
}
function words() {
  const w = new Uint32Array(8)
  const q = [[0, 0, 0, 1], [100, 200, 300, 2], [65535, 65535, 65535, 3], [5, 6, 7, 4]]
  q.forEach(([x, y, z, a], i) => { const [w0, w1] = packWords(x, y, z, a); w[i * 2] = w0; w[i * 2 + 1] = w1 })
  return w
}
describe('export', () => {
  it('compactPoints drops exactly the deleted points, keeps order and hidden ones, tracks q bounds', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, FLAG_HIDDEN, 0])
    const r = compactPoints(words(), flags, 4)
    expect(r.count).toBe(3)
    expect(r.words.length).toBe(6)
    expect(unpackWords(r.words[0], r.words[1])).toEqual([0, 0, 0, 1])
    expect(unpackWords(r.words[2], r.words[3])).toEqual([65535, 65535, 65535, 3])
    expect(unpackWords(r.words[4], r.words[5])).toEqual([5, 6, 7, 4])
    expect(r.qmin).toEqual([0, 0, 0]); expect(r.qmax).toEqual([65535, 65535, 65535])
  })
  it('exportManifest: one chunk, same quantization bounds, chunk bounds dequantized', () => {
    const m = exportManifest(src, 2, [100, 200, 300], [65535, 65535, 65535])
    expect(m.chunks).toHaveLength(1)
    expect(m.bounds).toEqual(src.bounds)
    expect(m.pointCount).toBe(2)
    expect(m.chunks[0].bounds.min[0]).toBeCloseTo(100 / 65535 * 10)
    expect(m.chunks[0].bounds.max).toEqual([10, 20, 30])
    expect(m.source).toBe('tile#export'); expect(m.name).toBe('demo (export)')
    expect(() => validateManifest(JSON.parse(JSON.stringify(m)))).not.toThrow()
  })
  it('zip round-trips through unzipSync', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, 0, 0])
    const r = compactPoints(words(), flags, 4)
    const m = exportManifest(src, r.count, r.qmin, r.qmax)
    const files = unzipSync(buildZip(r.words, m))
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'points.bin'])
    expect(files['points.bin'].byteLength).toBe(3 * 8)
    expect(new Uint32Array(files['points.bin'].slice().buffer)).toEqual(r.words)   // slice: unzip views may be unaligned for Uint32Array
    expect(JSON.parse(strFromU8(files['manifest.json'])).pointCount).toBe(3)
  })
})
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `src/viewer/edit/export.ts`:

```ts
import { strToU8, zipSync } from 'fflate'
import type { Manifest } from '../loader/manifest'
import { dequantize, unpackWords, WORDS_PER_POINT } from '../format/quant'
import { FLAG_DELETED } from '../render/PointBuffers'

type V3 = [number, number, number]

// Two passes: count survivors, then copy into a preallocated array (never array-push at 20M).
export function compactPoints(words: Uint32Array, flags: Uint8Array, n: number): { words: Uint32Array; count: number; qmin: V3; qmax: V3 } {
  let count = 0
  for (let i = 0; i < n; i++) if (!(flags[i] & FLAG_DELETED)) count++
  const out = new Uint32Array(count * WORDS_PER_POINT)
  const qmin: V3 = [65535, 65535, 65535], qmax: V3 = [0, 0, 0]
  let k = 0
  for (let i = 0; i < n; i++) {
    if (flags[i] & FLAG_DELETED) continue
    const w0 = words[i * 2], w1 = words[i * 2 + 1]
    out[k++] = w0; out[k++] = w1
    const [x, y, z] = unpackWords(w0, w1)
    if (x < qmin[0]) qmin[0] = x; if (x > qmax[0]) qmax[0] = x
    if (y < qmin[1]) qmin[1] = y; if (y > qmax[1]) qmax[1] = y
    if (z < qmin[2]) qmin[2] = z; if (z > qmax[2]) qmax[2] = z
  }
  if (count === 0) { qmin[0] = qmin[1] = qmin[2] = 0 }
  return { words: out, count, qmin, qmax }
}

export function exportManifest(src: Manifest, count: number, qmin: V3, qmax: V3): Manifest {
  const dq = (q: V3): V3 => [0, 1, 2].map((a) => dequantize(q[a], src.bounds.min[a], src.bounds.max[a])) as V3
  return {
    version: 1, name: `${src.name} (export)`, source: `${src.source ?? ''}#export`, license: src.license, crs: src.crs, units: 'm',
    bounds: src.bounds, pointCount: count, bytesPerPoint: 8, file: 'points.bin', classMap: src.classMap,
    chunks: [{ offset: 0, count, bounds: { min: dq(qmin), max: dq(qmax) } }],
  }
}

export function buildZip(words: Uint32Array, manifest: Manifest): Uint8Array {
  return zipSync({
    'points.bin': [new Uint8Array(words.buffer, words.byteOffset, words.byteLength), { level: 0 }],
    'manifest.json': strToU8(JSON.stringify(manifest, null, 1)),
  })
}
```

`loader.worker.ts` — before the `start` fallthrough:

```ts
  if (msg.type === 'export') {
    try {
      const r = compactPoints(msg.words, msg.flags, msg.words.length / WORDS_PER_POINT)
      const zip = buildZip(r.words, exportManifest(msg.manifest, r.count, r.qmin, r.qmax))
      ctx.postMessage({ type: 'exportDone', zip, count: r.count }, [zip.buffer])
    } catch (err) { ctx.postMessage({ type: 'exportError', message: String(err) }) }
    return
  }
```
(`msg.words`/`msg.flags` are released when the handler returns — the worker keeps nothing, A6.)

`useLoader.ts` — in the worker `onmessage`: `exportDone` → Blob download + `edit.busy = false`, message `exported ${count.toLocaleString()} points`; `exportError` → busy false + message. `api.exportZip = async () => { if (store.get().edit.busy) return; set busy; const m: LoaderIn = { type: 'export', words: (buffers.qpos.array as Uint32Array).slice(), flags: buffers.flagBytes.slice(), manifest }; worker.postMessage(m, [m.words.buffer, m.flags.buffer]) }`; cleanup clears it. Download helper:

```ts
function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

`App.tsx`: `const name = /^[a-z0-9-]+$/.test(params.get('data') ?? '') ? params.get('data')! : 'demo'` → `manifestUrl={`/data/${name}/manifest.json`}` (drop the `full`-only branch; `?data=full` still works).

- [ ] **Step 4: Run tests, tsc, build.**

- [ ] **Step 5: Browser — export and re-open (demo).** Navigate, load, lasso a region (`api.lasso` via `__pcvEdit`), `Delete`, read `deleted` count `D`. Click Export; Playwright saves the download (`browser_run_code_unsafe` with `page.waitForEvent('download')` → `saveAs('.playwright-mcp/export.zip')`), or intercept: expose `window.__pcvEdit.lastZip` (DEV) and write it via `browser_evaluate` returning base64 is too large — use the download event. Then in Bash: `mkdir -p public/data/export && unzip -o .playwright-mcp/export.zip -d public/data/export && python3 -c "import json;m=json.load(open('public/data/export/manifest.json'));print(m['pointCount'],len(m['chunks']))"` → `2000000 − D`, `1`. Navigate `http://localhost:5173/?data=export`, wait for `loaded N/N` with `N = 2000000 − D`; screenshot `p5-export.png`; console clean. Record the export wall time from the `busy` span (add `performance.now()` around it in the DEV handle) — at 2M it should be well under a second. Add `public/data/export/` to nothing — `public/data/` is already gitignored.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "edit: export zip (worker compaction + fflate), ?data=<name> harness"`

### Task 9: 20M measurements, docs, spec status

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md` (new `## Editing (phase 5)` + Deferred triage + Memory table), `docs/superpowers/specs/2026-09-15-phase-5-editing-design.md` (append "Plan rulings" pointer), `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` (phase 5 **Done.**)

- [ ] **Step 1: 20M session** — `?data=full`, `browser_wait_for` `20,000,000/20,000,000`, budget 100 %: (a) pick latency ×5 (`edit.pickMs`), (b) lasso replace over the centre square: `gpuMs`, `readbackMs`, `selected`; add + subtract once; (c) `hide` on the selection: time via `performance.now()` around `editor.hide()` (whole-buffer op + 20 MB `countFlags`), (d) `undo` time, (e) `split` on a ≥ 50k selection (fit time; note the `selectedPositions` scan), (f) export: wall time and zip size (skip the download re-open at 20M unless cheap). Console clean throughout; HUD frame ms unchanged in orbit mode (the tint blend adds vertex-stage ops — record 20M frame ms before/after at 2 px, home pose, like the Phase 4 shading row).
- [ ] **Step 2: README** — Status line ("Phase 5 done: …"), Controls table (mouse: click / ⇧ / ⌥ pick; lasso drag; keys `L Esc I X Delete U C S ⌘Z ⇧⌘Z`; toolbar), a "Editing" paragraph (flags model, undo ring limits: 30 commands / 256 MB — whole-buffer edits cost N bytes, ≈12 at 20M), an "Export" note (format = same v1 layout, one chunk, re-open via `?data=<folder>` in the dev harness), perf lines: lasso GPU ms @2M/@20M, flags readback ms @20M, pick ms, export time.
- [ ] **Step 3: ARCHITECTURE** — `## Editing (phase 5)` with: flags mirror + upload path (`flagBytes`, `uploadFlagsRange`), kernels (`pcvProject`, pick two-pass `bitcast<u32>` depth min, thread-per-word lasso, `chunkTable` budget rule), tint blend (branchless, `vertexStage(vec3)`), editor/ops/undo semantics (push-before-mutate, `dropLast`, `selRange`), plane fit (RANSAC 200 / PCA via `smallestEigenvector`, threshold 2 × spacing, 50k sample), export pipeline, measured numbers, spike outcomes (`mat4x4` param, `atomicMin`), and the accent-from-CSS note. Memory table: `pick` 8 B, `polygon` 2 KB, `chunkTable` 2 KB (negligible), undo ring ≤ 256 MB CPU. Deferred: move the renderer-leak / `<Scene key>` owner from "Phase 5" to "any"; add: multi-viewer accent lookup takes the first root; lasso readback is whole-buffer (partial-range fallback noted); `selectedPositions` is a full N scan; export at 20M peaks ≈ 3 × 160 MB CPU.
- [ ] **Step 4: Spec status** — phase-5 spec: append `## Plan rulings` → pointer to this plan's table; master spec §7 item 5 → `**Done.**`; drift doc already points here.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "phase 5 docs: editing architecture, 20M numbers, README controls/export"`

### Task 10: Gates, whole-branch review, merge

- [ ] `npx tsc --noEmit && npx vitest run && npm run build && tools/.venv/bin/pytest tools/tests -q` — all green; `npm run build` output has no new warnings beyond the chunk-size one.
- [ ] Whole-branch review (`superpowers:requesting-code-review` against this plan + the spec): kernel rules (returns + `.toVar()`, no `toReadOnly`, thread-per-word flags writes, `vertexStage` on the tint), busy serialisation, undo byte accounting, focus scoping.
- [ ] `git checkout main && git merge --no-ff phase-5-editing -m "merge phase-5-editing" && git push origin main && git branch -d phase-5-editing`
- [ ] `/deslop` over `src/viewer/edit/`, `src/viewer/compute/wgsl/select.ts`, `src/viewer/ui/{Toolbar,LassoOverlay,keys}.tsx`, the touched parts of `PointCloudViewer.tsx`, `pointMaterial.ts`, `useLoader.ts`; commit to `main`.

## Self-review

- **Spec coverage**: pick (A2, Task 6) · lasso ≤ 256 verts, three modes, thread-per-word, full readback A5 (Tasks 4, 6) · ops + side filter (Task 2, 5) · plane fit RANSAC 200 / 2 × spacing / ≤ 50k / PCA (Task 3, 5) · undo ring 30 / 256 MB, redo cleared, shortcuts (Tasks 1, 7) · export worker + fflate + re-open (Task 8) · toolbar + lasso overlay + focus-scoped keys (Task 7) · selected/hidden/deleted/split rendering (Task 5) · acceptance: 20-cursor pick check (6.5), lasso < 20 ms @20M + readback ms (6.6, 9.1), undo/redo byte-exact (1, 5), ring eviction both caps (1), export re-opens with the non-deleted count (8.5), rendering (5.5, 7.5), shortcuts outside focus (7.6) · vitest list: undo, lasso, plane, export, flags — all present, plus ops/editor/project/keys · docs (Task 9). Spec deviations are all in the rulings table (11–20).
- **Placeholders**: none — every code step carries the code; browser steps carry the exact evaluate snippets.
- **Type consistency**: `Range { min, max }` everywhere (not `minIdx/maxIdx` — the spec's field names are renamed once, in Task 0); `SelectMode`/`SplitSide`/`EditTool`/`EditState` from `store.ts`; `Editor` methods `isolate/hide/del/unhideAll/clearSelection/split/pick/beginGpuEdit/endGpuEdit/undo/redo/refresh/dispose` used identically in Tasks 5–7; `api.pick(x, y, mode)`, `api.lasso(poly, mode)`, `api.exportZip()`, `api.viewSize()`; `cpuPick`'s `radiusPx` is `(i, depth)` in Task 4 and Task 6 alike.

## Unresolved questions

- Click modes: plain = replace (miss clears), ⇧ add, ⌥ subtract — OK?
- Pick/lasso honour the budget prefix (invisible points never selected) — OK?
- Hide key `X` (H stays HUD) — OK?
- Export re-open = fresh page load via `?data=<folder>`; live dataset switch stays deferred — OK?
- Split colours teal `#2ec4b6` / orange `#ff9f1c`; selection = `--pcv-accent` at 70 % — OK?
- Keep `Backspace` as delete (browser back-nav risk is nil inside a focused div)?
- Phase 6 prerequisites: hosting choice (website static + CORS vs bucket)? `ffmpeg` on the machine for the webm?
