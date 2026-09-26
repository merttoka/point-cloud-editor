# Phase 7: Layers & Segments — Design Spec

Date: 2026-09-26
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` (§2 viewer, §4 editing; Amendments A1–A12 apply). Phase 6 is complete; this phase starts from `main` after `b64f3e4`.

## Goal

Let the user see and control the dataset by layer: every LiDAR class the tile carries as a row (visibility, count, select), plus manual segments the user carves out of a selection and names, in the same list. Selection tools only take visible layers, so hiding ground and vegetation and drawing a lasso over a roof selects the building alone. Segments survive export and re-open.

Automatic per-building/per-tree instances (connected components) are **parked** for a later phase; this phase leaves room for them (a segment id per point, a list model) without building them.

## Decisions (from the brainstorm)

- **Exclusive membership**: a point belongs to at most one manual segment (`segId` u8 per point, 0 = none, 1–255).
- **Two independent axes**: a point is drawn when its class row is visible **and** its segment row (if any) is visible. Class counts always cover the whole class; saving a segment does not remove points from their class row.
- **Layer visibility is a non-destructive mask** (uniforms/small buffers), separate from the `hidden` flag, not in the undo ring; layer-hidden points still export.
- **Segment create / rename / recolour / delete are list actions outside the undo ring.** `selectLayer` (row click) goes through the undo ring like a lasso.
- **A "Segments" colour mode** paints each segment with its colour, unsegmented points grey.
- **Export includes segments** (`segments.bin` + a `segments` table in the manifest, optional fields; v1 layout otherwise unchanged); re-open restores them. Visibility state is not persisted.
- **Session scope otherwise**: no persistence beyond export, ≤ 255 segments.

## Scope

In: `segId` buffer + CPU mirror, layer masks in the vertex stage and both select kernels (+ CPU reference), class counting, segment table in the store, editor operations, `Layers` card UI, "Segments" colour mode, export/import of segments, tests, docs (README controls, ARCHITECTURE section, EMBEDDING props unchanged), 2M/20M checks via the bench handle.
Out: automatic instances, per-layer export filters, persisted visibility, > 255 segments, changes to the undo ring format, changes to the point format (`points.bin`).

## Interfaces

### Buffers (`render/PointBuffers.ts`)
- `segIds: StorageBufferAttribute` (`Uint32Array(ceil(N/4))`, one byte per point, same packing as `flags`), `segIdsNode`, `segBytes: Uint8Array` view, `uploadSegRange(minIdx, maxIdx)` (word-aligned, mirrors `uploadFlagsRange`). Allocated at manifest load, zeroed. +20 MB at 20M.
- `LayerMasks` (`render/layerMasks.ts`): `classMask: u32` (bit `min(cls, 31)`), `segMask: Uint32Array(8)` (bit per segment id; bit 0 = unsegmented points), both in one `StorageBufferAttribute` of 9 words uploaded whole on change; `segColors: StorageBufferAttribute` of 256 packed `0xRRGGBB` words. Helpers (pure, tested): `classBit(cls)`, `setBit(mask, i, on)`, `isVisible(cls, segId, masks)`.

### Vertex stage (`render/pointMaterial.ts`)
- Reads `classMask`/`segMask` words and the point's `segId` byte alongside the flag byte (all through `vertexStage()`); `visible = classBit × segBit` multiplies into the existing size term so a masked point collapses like a hidden one. Branchless, per the vertex-stage rule.
- Colour mode `segments`: `segColors[segId]` decoded to RGB; `segId == 0` → `#8a8a8a`. Added to `ColorMode` and the Panel select.

### Select kernels (`compute/wgsl/select.ts`, `edit/selectPipeline.ts`)
- The kernels' visibility predicate becomes `flags ok && classBit && segBit`, reading the same masks buffer and the `segIds` words. `ViewParams` unchanged; the masks node is bound once at pipeline creation.
- `bench/cpuReference.ts` `visible(i)` applies the same masks so `cpuLasso === lasso.selected` still holds in the runbook.

### Store (`state/store.ts`)
```ts
interface Segment { id: number; name: string; color: string /* #rrggbb */; count: number; visible: boolean }
interface LayersState { classCounts: Record<number, number>; classVisible: Record<number, boolean>; segments: Segment[] }
colorMode: 'height' | 'intensity' | 'class' | 'segments'
```
`classCounts` is computed once when `status` becomes `ready` (one pass over the point words on the main thread, ≈30 ms at 20M, before the ready flip so the list never shows zeros). Only classes with count > 0 get rows. Default: every class and segment visible.

### Editor (`edit/editor.ts`, `edit/layers.ts` for the pure byte ops)
Outside the undo ring: `saveSegment(name?: string): Segment | null` (claims the current selection ∩ split-side filter; returns null when nothing is selected or 255 ids are in use; name defaults to `Segment N`, colour cycles a 12-entry palette), `deleteSegment(id)`, `renameSegment(id, name)`, `setSegmentColor(id, color)`, `setLayerVisible(layer: { class: number } | { segment: number }, visible)`, `soloLayer(layer)`, `showAllLayers()`.
Through the undo ring (whole-buffer push, like lasso): `selectLayer(layer, mode: SelectMode)` sets/clears the selected bit on every *visible* point of the layer.
Existing ops (`isolate`, `hide`, `del`, `split`, pick, lasso) treat mask-hidden points as hidden: the ops' per-point predicate gains the mask test through one shared `visibleIndex(i)` helper in `edit/layers.ts`.
Counts: segment `count` is set at save time and decremented by delete of points (`del` reduces counts of affected segments via one pass over the touched range).

### UI (`ui/LayersPanel.tsx`, `LayersPanel.module.css`)
Card on the right below the existing Panel, collapsible, `--pcv-*` tokens. "Classes" group: swatch (class colormap colour), name (ASPRS name table, "Class N" fallback), count, eye. "Segments" group: colour swatch (click → colour input), inline-editable name, count, eye, ×. Footer: "Save selection as segment" (enabled when `edit.counts.selected > 0`), "Show all". Row click → `selectLayer(replace)`, ⇧ add, ⌥ subtract; double-click → `soloLayer`. Keys unchanged. Layer changes never steal focus from the viewer root beyond the row's own inputs.

### Export / import (`edit/export.ts`, `loader/loader.worker.ts`, `loader/manifest.ts`, `loader/useLoader.ts`)
- Export message carries `segBytes` (copy) and the segment table; the worker writes `segments.bin` (one byte per kept point, in output order) and adds `"segments": [{ "id", "name", "color" }]` + `"segmentsFile": "segments.bin"` to the manifest when the table is non-empty.
- `validateManifest` accepts the optional fields (`segments` array of `{ id: 1–255, name: string, color: #rrggbb }`, `segmentsFile: string`). After the last chunk, if `segmentsFile` is set, the loader fetches it whole (relative to the manifest), fills `segBytes`, uploads once, and rebuilds `layers.segments` with counts from the bytes (ids listed in the table but absent from the bytes get count 0; ids in the bytes but not in the table are dropped to 0 with a console warning).

## Acceptance criteria

- With ground and vegetation hidden, a lasso over a building selects only class-6 points: `lasso.selected === lasso.cpuSelected`, and `classStats`-style counting of the selection shows one class.
- Save → segment row appears with the right count and colour; solo shows only it; "Segments" colour mode paints it; delete returns its points to unsegmented.
- Export with two segments → re-open shows both rows with matching counts and colours; an export with no segments produces a manifest without the optional fields and re-opens as today.
- Frame time at 20M (100 % budget, home pose) within ±1 ms of phase 6's row with all layers visible; hiding all but one class renders faster, never slower.
- Undo/redo of a `selectLayer` behaves like a lasso undo; segment operations do not appear in undo.
- All gates: `tsc`, vitest, build, pytest; grep gates from phase 6 still hold; no `window` globals in `src/viewer`.

## Risks and spikes

- **Word packing collisions**: `segBytes` writes are per byte on the CPU and uploaded per word range, like flags; GPU never writes `segIds` in this phase, so no atomics needed.
- **Vertex-stage read count**: two more storage reads per vertex. Phase 5 added three without measurable cost; verify at 20M before merging (bench handle `frame()` before/after).
- **Class counting on the main thread at 20M** (~30 ms once): acceptable; if it shows as a hitch, move it into the loader worker's `done` path.
- **Colormap for classes in the list** must match `render/colormaps.ts` ASPRS colours; single source (export the table).

## Tests

vitest (pure modules): `layers.ts` byte ops (claim, delete, count, id allocation/reuse), mask bit helpers, `isVisible`, class counting over synthetic words, `selectLayer` ranges + undo depth, export compaction with segments (round trip through `parseManifest`/`segments.bin`), manifest validation of the optional fields. pytest unchanged. Browser checks listed under Acceptance via the bench handle (`?bench=1`), 2M and 20M.

## Docs

README Controls (Layers card, colour mode, export note), ARCHITECTURE `## Layers (phase 7)` with the buffer, masks, kernel predicate and measured numbers, Deferred triage (parked level 2 entry), EMBEDDING unchanged (no new props), master spec phase list gains 7.
