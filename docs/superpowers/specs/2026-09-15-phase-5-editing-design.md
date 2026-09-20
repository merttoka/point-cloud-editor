# Phase 5: Editing — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §4, §7.5 (amendments A2 compute pick, A5 full flags readback, A8 size-0 hide, A9 dispatch apply)

## Goal

Select points by click or lasso on the GPU, apply flag-based edits (isolate, hide, delete, split) with byte-exact undo/redo, and export the surviving points as a re-openable dataset zip.

## Scope

In: `project.wgsl` kernel family (pick + lasso), flags mirror + dirty-range upload, ops, RANSAC/PCA plane split, undo ring, export worker path, toolbar + lasso overlay UI, focus-scoped shortcuts, selected/hidden/deleted rendering.
Out: box/plane gizmos, point translation or attribute editing, multi-selection sets, persistent sessions, touch input.

## Interfaces

### Per-point flags
u8 per point, packed 4 per u32 in the global flags storage buffer (Phase 2). Bits: `hidden = 1`, `selected = 2`, `deleted = 4`, `splitA = 8`, `splitB = 16`. The CPU `Uint8Array` mirror is the source of truth; every edit mutates the mirror then uploads only `[minIdx, maxIdx]` via the attribute's update range (mechanism verified in Phase 2). Vertex stage: `hidden | deleted` → `sizeNode = 0` (degenerate quad, A8); `selected` → tinted accent colour; `splitA` / `splitB` → two distinct colours overriding the colormap.

### Layout
```
src/viewer/compute/select.wgsl.ts      # project.wgsl family: pickDepth, pickIndex, lasso kernels (wgslFn)
src/viewer/edit/flags.ts               # bit constants, mirror, dirty range, upload, GPU→CPU readback
src/viewer/edit/lasso.ts               # polygon capture state, point-in-polygon (CPU ref impl), dispatch
src/viewer/edit/ops.ts                 # isolate / hide / delete / unhideAll / clearSelection / split
src/viewer/edit/plane.ts               # RANSAC + PCA refine
src/viewer/edit/undo.ts                # command ring
src/viewer/edit/export.ts              # worker message + zip + download
src/viewer/ui/Toolbar.tsx              # mode buttons, op buttons, undo/redo
src/viewer/ui/LassoOverlay.tsx         # SVG polygon overlay over the canvas
```

### `project.wgsl` kernel family
Shared prologue: read `qpos[i]`, dequantize with `dqMin`/`dqScale` uniforms (world centred at bounds centroid, as Phase 2), multiply by a `viewProj` uniform (`mat4`), perspective divide → screen px using `viewport` uniform. Points with `hidden | deleted` set return early.
- **Pick** (`r = max(3 px, pointSize)`), two dispatches, one thread per point, over a 2-word `storage(attr, 'uint', 2).toAtomic()` buffer `pick = [minDepth, minIndex]` that the main thread resets to `0xffffffff` before each pick (write the attribute array, `needsUpdate = true`):
  1. `pickDepth`: if `|screen − cursor| ≤ r`, `atomicMin(&pick[0], bitcast<u32>(clipZ / clipW))`. Depth in `[0, 1]` is a non-negative f32, whose bit pattern orders the same as its value, so the min is exact; `u32(depth × 0xffffffff)` is not (f32 has 24 mantissa bits, and `0xffffffff` is not representable).
  2. `pickIndex`: if within `r` and `bitcast<u32>(clipZ / clipW) == atomicLoad(&pick[0])`, `atomicMin(&pick[1], i)` (same expression as pass 1, so bit-identical; elements of an atomic array can only be read through `atomicLoad`).
  Readback: 8 bytes; `pick[1] == 0xffffffff` means miss.
- **Lasso**: polygon ≤ 256 screen-space vertices in a small **storage** buffer (`StorageBufferAttribute(Float32Array(512), 2)`, `ptr<storage, array<vec2<f32>>, read_write>`; a uniform `array<vec2<f32>>` is illegal in WGSL, uniform arrays need a 16-byte element stride, and TSL's `uniformArray` pads to `vec4` and cannot be passed as a `wgslFn` pointer) + a `vertexCount` uniform; even-odd point-in-polygon per point. Thread-per-word: each thread owns 4 consecutive points, reads the flags word once, tests each point, applies the mode, writes the whole word back (no atomics). Modes via a `mode` uniform: `replace` (clear `selected` everywhere first, then set inside), `add` (Shift: OR inside), `subtract` (Alt: AND-NOT inside). After dispatch: read back the full flags buffer (`N` bytes, 20 MB at 20M) into the CPU mirror (amendment A5).

### Ops (`ops.ts`)
All operate on the mirror over the affected range, then upload:
- `isolate`: set `hidden` on every point without `selected` (range = whole buffer).
- `hide`: set `hidden` on selected; `delete`: set `deleted` on selected; both clear `selected`.
- `unhideAll`: clear `hidden` everywhere. `clearSelection`: clear `selected` everywhere.
- `split`: fit a plane to the selection, tag `splitA` (signed distance ≥ 0) / `splitB` (< 0) on selected points; subsequent isolate/hide/delete accept a side filter (`A` / `B`).
Each op records one undo command before mutating.

### Plane fit (`plane.ts`)
Input: dequantized positions of selected points (mirror for the `selected` bit, main-thread `qpos.array` for positions, A6), uniformly sampled to ≤ 50k; runs on the main thread. RANSAC: 200 iterations, 3-point hypotheses, inlier threshold = 2 × mean spacing (`sqrt(areaXY / pointCount)` from the manifest, same estimate as Phase 4). Refine: PCA on inliers, normal = smallest eigenvector, centroid on plane. Returns `{ normal, d, inlierRatio }`; fewer than 3 selected points → no-op with a HUD message.

### Undo (`undo.ts`)
Command = `{ minIdx, maxIdx, prevFlags: Uint8Array }` (dense slice of the mirror before the edit). Ring holds ≤ 30 commands **and** ≤ 256 MB of `prevFlags` bytes; pushing evicts oldest until both limits hold. Lasso, isolate, unhide-all and clear-selection touch the whole buffer, so at 20M each costs a 20 MB slice and the byte cap allows ~12 of them; expected, documented in README. Redo stack cleared on new push. Apply = swap current slice with stored slice, upload range. Shortcuts: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo.

### Export (`export.ts`)
Message to the loader worker: `{ type: 'export', words: qpos.array.slice(), flags: Uint8Array }` with both buffers transferred (one 160 MB copy at 20M, ~50 ms; the worker keeps nothing afterwards, A6). Worker compacts points whose `deleted` bit is clear into a new `points.bin` (same quantization bounds, one chunk, chunk bounds recomputed), builds `manifest.json` (`version: 1`, `source` = original + `#export`), zips both with `fflate` (`zipSync`, level 0 for the bin) and posts the blob back. Main thread triggers a download of `export.zip`. The zip contents re-open in the viewer by pointing `manifestUrl` at the extracted manifest.

### UI + shortcuts
`Toolbar.tsx`: mode toggle (orbit / lasso), op buttons, undo/redo, split side selector, export. `LassoOverlay.tsx`: absolutely positioned SVG over the canvas, pointer events captured only in lasso mode, polygon closed on pointer-up or double-click. Shortcuts handled on the viewer root (`tabIndex=0`) and only while `root.contains(document.activeElement)`: `L` lasso mode, `Esc` cancel / back to orbit, `I` isolate, `H` hide, `Delete` / `Backspace` delete, `U` unhide all, `C` clear selection, `S` split.

## Acceptance criteria

- Click picks the visually front-most point: Playwright projects the demo set on the CPU for 20 random cursor positions and the GPU pick returns the nearest-depth point within `r` in each case (ties: any point at that depth).
- Lasso over 20M points < 20 ms GPU (timestamp query); full-flags readback time at 20M reported in the HUD/README.
- Undo then redo restores the mirror byte-exact (vitest + manual).
- Ring eviction verified for both the 30-count and the 256 MB byte cap.
- Export re-opens in the viewer and its `pointCount` equals the non-deleted count.
- Hidden/deleted points never render; selected points show the accent tint; split sides show two distinct colours.
- Shortcuts do nothing when focus is outside the viewer root.

## Risks and spikes

- **`atomicMin` on storage nodes**: verify `storage(...).toAtomic()` + `atomicMin` compile in a `wgslFn` kernel with `ptr<storage, array<atomic<u32>>, read_write>` (three wraps atomic storage as `value: array<atomic<u32>>`, Phase 4 spike covers `atomicAdd`); fallback is a TSL `atomicFunc` node.
- **Readback latency**: `renderer.getArrayBufferAsync` on a 20 MB buffer; measure at 20M. If > 100 ms, fall back to reading only the dirty range implied by the lasso's screen bounds (spec amendment).
- **`viewProj` precision**: positions are centred at the bounds centroid (Phase 2), so float32 clip math matches the vertex stage; verify pick agreement at the far corners of the full set.
- **Thread-per-word `replace` mode** clears `selected` across the whole buffer in the same pass; confirm no ordering hazard (each word owned by exactly one thread).
- **Export copy** at 20M is a transient 160 MB (main slice → worker); compaction writes into a preallocated `Uint32Array` sized by the non-deleted count, never array-push. Peak CPU during export ≈ 3 × 160 MB.

## Tests (vitest)

- `undo.ts`: push/undo/redo round-trip byte-exact; eviction at 31 commands; eviction when `prevFlags` bytes exceed the cap with fewer than 30 commands.
- `lasso.ts` CPU point-in-polygon: convex, concave, self-touching polygons, points on edges, matches the WGSL even-odd rule.
- `plane.ts`: RANSAC + PCA on synthetic planes with Gaussian noise and 30% outliers → normal within 1° and offset within threshold.
- `export.ts`: compaction drops exactly the deleted points, preserves order, zip round-trips through `fflate.unzipSync`, manifest chunk count = 1 and bounds unchanged.
- `flags.ts`: bit set/clear helpers, dirty-range accumulation, word packing matches the vertex-stage unpack.

## Docs

README: editing controls, shortcut table, export format note. ARCHITECTURE: editing/undo model, pick + lasso kernels, flags sync path, export pipeline.

## Plan rulings

Shipped behaviour follows the rulings table in `docs/superpowers/plans/2026-09-19-phase-5-editing.md` § "Rulings on the spec-review items (Phase 5 §1–10) and further drift" where it differs from this spec (notably: `H` stays HUD and `X` = hide; budget-visible selection via `chunkTable`; click modes plain / ⇧ / ⌥; re-open is a fresh `?data=<name>` page load; `busy` serialisation; `selRange`-scoped picks; readback copies into the mirror without `needsUpdate`). Measured numbers and deferred items: `docs/ARCHITECTURE.md` § Editing (phase 5).
