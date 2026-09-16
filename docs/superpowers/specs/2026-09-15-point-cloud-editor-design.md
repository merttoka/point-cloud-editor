# Point Cloud Editor — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)

## Goal

Clean-room WebGPU point cloud viewer/editor. Portfolio piece demonstrating production-grade real-time 3D: 5–20M point LiDAR, GPU compute (WGSL), editing ops, explicit perf numbers. Ships as a Lab experiment and 2026 portfolio entry.

## Hard constraints

- Written from scratch. Public techniques + public data only. No reference to any NDA material.
- Data: USGS 3DEP LiDAR. Tile priority: Los Angeles → Santa Barbara → San Francisco → NYC (by availability, must include building + vegetation classes). Raw LAZ never committed.
- Stack: Vite + React 19 + TypeScript, Three.js via React Three Fiber (v9) on `WebGPURenderer`, raw WGSL compute on the same `GPUDevice`, CPU fallback (Web Worker) with runtime toggle. Python venv: laspy[lazrs], pyarrow, numpy, scipy. Extra deps approved: `@react-three/drei`, `vitest`, `pytest`. Debug panel hand-rolled (no leva).
- Embeddable: `src/viewer/` self-contained (CSS modules, no global CSS), `PointCloudViewer` props `{ manifestUrl, theme?, className? }`. Lab will copy the folder and add three/R3F deps.
- Repo: `github.com/merttoka/point-cloud-editor`, public, MIT. Local folder `~/Developer/Graphics/TS_PointCloud`.

## 1. Data pipeline

### Tools (`tools/`, Python venv)
- `fetch.py` — downloads chosen LAZ tile(s) into `data/raw/` (gitignored); prints source URL + license.
- `preprocess.py IN.laz OUT_DIR [--max-points N] [--cell-size M] [--demo N] [--shuffle] [--help]`
  1. Read LAZ (laspy). Optional stride/random subsample to `--max-points`.
  2. Global AABB → quantize XYZ to u16 (`q = round((p - min) / (max - min) * 65535)`).
  3. Intensity: u16 → u8 via p1–p99 normalization. Classification: raw ASPRS u8.
  4. Spatial chunking on a 2D XY grid (`--cell-size` metres, default 64). One `.bin` per non-empty cell.
  5. `--shuffle`: random permutation inside each chunk so any prefix is a uniform subsample.
  6. `--demo N`: also emit a second, subsampled dataset (default 2M) to `OUT_DIR/demo/`.

### Chunk format (v1, little-endian, 8 B/pt, interleaved)
```
[u16 x][u16 y][u16 z][u8 intensity][u8 class]
```
### Manifest (`manifest.json`)
```json
{ "version": 1, "source": "...", "crs": "...", "bounds": {"min":[x,y,z],"max":[x,y,z]},
  "pointCount": N, "bytesPerPoint": 8,
  "classMap": {"2":"Ground","5":"High Vegetation","6":"Building", "...":"..."},
  "chunks": [{ "file": "c_0003_0007.bin", "count": n, "bounds": {"min":[..],"max":[..]} }] }
```
Demo (2M, ~16 MB) lives in `public/data/demo/`. Full set (≤20M, ≤160 MB) attached to a GitHub Release; viewer takes the manifest URL as a prop, chunk URLs resolved relative to it.

Export (editing) writes the same format: deleted points dropped, one chunk, new manifest. Exports re-open in the viewer.

## 2. Viewer

### Module layout (`src/viewer/`)
- `PointCloudViewer.tsx` — public component.
- `loader/` — manifest fetch; chunk streaming (concurrency 4, priority by camera distance to chunk AABB center, AbortController on unmount); each chunk → GPU buffers immediately (progressive).
- `render/` — R3F `<Canvas>` with `WebGPURenderer`; one `Points` object per chunk; NodeMaterial dequantizes u16 positions via `uint` attribute + `dequant` uniform (`min`, `scale`); per-point `flags` u32 storage buffer (bits: hidden, selected, deleted, splitA/splitB); point size (px) with perspective attenuation + min/max clamp.
- `compute/` — WGSL passes + CPU worker equivalents.
- `edit/` — selection, ops, undo, export.
- `ui/` — control panel, perf/debug HUD, CSS modules. Theme via `theme` prop (or `data-theme` on ancestor) → CSS vars mirroring Lab tokens.

### Colormaps
256×1 LUT textures: height + intensity use continuous maps (viridis, turbo, grayscale); classification uses categorical ASPRS palette. Mode + LUT selectable in panel.

### Eye-dome lighting
Post pass: scene rendered to color + depth RT; EDL shades each pixel by log-depth gradient to neighbours (Boucheny). Params: radius (px), strength. Toggle on/off.

### Camera
drei `OrbitControls`, auto-fit to manifest bounds on load, damping on.

## 3. GPU compute

All passes run on Three's `GPUDevice`; buffers shared with rendering via `StorageBufferAttribute` (no readback).

1. `hash_build.wgsl` — cell key per point (cell = search radius), histogram, prefix scan, scatter → sorted point indices + cell start offsets.
2. `normals.wgsl` — per point: visit 27 neighbour cells, keep k=16 nearest (register insertion sort), covariance, smallest eigenvector via Jacobi 3×3, orient toward +Z / camera; write oct-encoded normal (u32).
3. `ao.wgsl` — per point: fraction of neighbours within radius lying above tangent plane → occlusion term.

Timing: WebGPU timestamp queries per pass (feature-detected). CPU fallback: same algorithms in TS (typed arrays) inside a Web Worker; results uploaded as attributes. Debug panel table: pass × {GPU ms, CPU ms}. Runtime toggle re-runs and refreshes table. Shading modes: flat, normal-lit, normal-lit + AO.

## 4. Editing

- **Click select**: ID render target (point index → RGBA), 1-px readback under cursor.
- **Lasso select**: polygon in screen space; worker projects points (view-proj on quantized positions) and does point-in-polygon; progress shown; result = `Uint32Array` indices.
- Selection → `selected` bit in flags buffer (partial buffer update).
- **Ops**: isolate (hide non-selected), hide, delete, unhide-all, clear selection.
- **Split box**: user draws an axis-aligned box; plane fitted to selected points inside it (RANSAC for inliers → least-squares refine); box base snaps to plane; points above/below plane tagged splitA/splitB and colored distinctly. Each side can then be isolated/deleted.
- **Undo**: command pattern; each command stores affected indices + previous flag bits; 30-deep ring buffer; Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z redo.
- **Export**: worker compacts non-deleted points → one `.bin` + `manifest.json`, downloaded as two files.

## 5. Perf & docs

- HUD: frame ms (EMA), FPS, draw calls, loaded/total points, last compute pass ms.
- README perf table (M1 baseline): load time, FPS at 2M / 10M / 20M, normals + AO ms GPU vs CPU, lasso ms.
- README: setup, data download + preprocess instructions, controls, screenshots/webm, perf table.
- `docs/ARCHITECTURE.md`: data flow, chunk format, compute pipeline, editing/undo model. Updated each phase.

## 6. Testing

- vitest: chunk parser/dequant, undo ring buffer, plane fit (RANSAC + LSQ on synthetic planes), CPU spatial hash + kNN (compared against brute force), export compaction.
- pytest: preprocess round-trip on a synthetic LAS (quantization error bound, chunk counts sum, manifest schema).
- Manual: browser smoke on demo dataset each phase.

## 7. Phases (one branch → merge to main each)

0. scaffold — Vite/R3F/WebGPU hello, repo, MIT, CI-less.
1. preprocess — tools, demo dataset, tests.
2. viewer — streaming, orbit, point size, EDL, colormaps.
3. compute — hash, normals, AO, timing panel, CPU fallback.
4. editing — selection, ops, split box, undo, export.
5. perf-docs — HUD numbers, README table, screenshots/webm, ARCHITECTURE, portfolio blurb.

## Out of scope (YAGNI)

Octree LOD, multi-tile mosaics, mesh reconstruction, server backend, mobile touch editing, zipped export.
