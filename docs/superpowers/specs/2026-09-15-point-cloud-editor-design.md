# Point Cloud Editor — Design Spec

Date: 2026-09-15
Status: approved (brainstorm + review pass)

## Goal

Clean-room WebGPU point cloud viewer/editor. Portfolio piece demonstrating production-grade real-time 3D: 5–20M point LiDAR, GPU compute (WGSL), editing ops, explicit perf numbers. Ships as a Lab experiment and 2026 portfolio entry.

## Hard constraints

- Written from scratch. Public techniques + public data only. No reference to any NDA material.
- Data: USGS 3DEP LiDAR. Tile priority: Los Angeles → Santa Barbara → San Francisco → NYC (by availability, must include building + vegetation classes; NYC 2017 is the safe fallback). Raw LAZ never committed.
- Stack (pinned, exact): `three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `vite@8.3.0`, TypeScript. Three via R3F on `WebGPURenderer`; compute kernels in raw WGSL via TSL `wgslFn` + `storage()` nodes (no internal backend API). Extra deps approved: `vitest`, `pytest`, `fflate` (export zip). Debug panel hand-rolled (no leva). Python venv: laspy[lazrs], pyarrow, numpy, scipy.
- **WebGPU required.** No WebGL fallback. Unsupported browser → message. CPU compute path is benchmark-only (see §3).
- Embeddable: `src/viewer/` self-contained (CSS modules, no global CSS), `PointCloudViewer` props `{ manifestUrl, theme?, className? }`. Lab will copy the folder and add three/R3F deps. Keyboard shortcuts focus-scoped to the viewer element (never hijack host page).
- Repo: `github.com/merttoka/point-cloud-editor`, public, MIT. Local folder `~/Developer/Graphics/TS_PointCloud`.

## 1. Data pipeline

### Tools (`tools/`, Python venv)
- `fetch.py` — downloads chosen LAZ tile(s) into `data/raw/` (gitignored); prints source URL + license.
- `preprocess.py IN.laz OUT_DIR [--max-points N] [--cell-size M] [--demo N] [--stats] [--help]`
  1. Read LAZ (laspy). Read CRS + linear unit from header (State Plane = US survey feet; convert `--cell-size` accordingly). `--stats`: print class histogram + point count and exit (tile vetting).
  2. Optional stride/random subsample to `--max-points`.
  3. Global AABB → quantize XYZ to u16 (`q = round((p - min) / (max - min) * 65535)`).
  4. Intensity: u16 → u8 via p1–p99 normalization. Classification: raw ASPRS u8.
  5. Spatial chunking on a 2D XY grid (`--cell-size` metres, default 64). Chunks written sequentially into **one** `points.bin`; manifest records per-chunk `offset` + `count`. Chunk order in manifest = global point index order.
  6. Always shuffle inside each chunk (random permutation) so any prefix is a uniform subsample → drives the viewer's point-budget slider.
  7. `--demo N`: also emit a second, subsampled dataset (default 2M) to `OUT_DIR/demo/`.

### Point format (v1, little-endian, 8 B/pt, interleaved)
```
[u16 x][u16 y][u16 z][u16 packed = intensity | (class << 8)]
```
Read on GPU as a single `uint16x4` vertex attribute (WebGPU has no 16-bit ×3 format). Byte layout identical to `[u8 intensity][u8 class]`.

### Manifest (`manifest.json`)
```json
{ "version": 1, "source": "...", "crs": "...", "units": "m",
  "bounds": {"min":[x,y,z],"max":[x,y,z]},
  "pointCount": N, "bytesPerPoint": 8, "file": "points.bin",
  "classMap": {"2":"Ground","5":"High Vegetation","6":"Building", "...":"..."},
  "chunks": [{ "offset": 0, "count": n, "bounds": {"min":[..],"max":[..]} }] }
```
Demo (2M, ~16 MB) lives in `public/data/demo/`. Full set (≤20M, ≤160 MB) attached to a GitHub Release (2 assets: manifest + bin). Viewer takes manifest URL as prop; `points.bin` resolved relative to it; chunks fetched via HTTP `Range`. Loader detects a `200` without `Content-Range` (Range unsupported) and falls back to one full fetch, slicing locally. Phase 1 verifies Range + CORS survive the release-asset redirect; if not, host on website static.

Export writes the same format: deleted points dropped, one chunk, same quantization bounds, zipped (`fflate`) as `export.zip` = `points.bin` + `manifest.json`. Exports re-open in the viewer.

## 2. Viewer

### Module layout (`src/viewer/`)
- `PointCloudViewer.tsx` — public component.
- `loader/` — manifest fetch; chunk streaming (concurrency 4, priority by camera distance to chunk AABB center, queue re-sorted on camera move, AbortController on unmount); each chunk → GPU immediately (progressive). Worker owns the CPU copy (needed by CPU benchmark path); main thread gets a transferred copy for upload.
- `render/` — R3F `<Canvas>` with `WebGPURenderer`; one `Points` per chunk, `uint16x4` attribute, `dequant` uniform (`min`, `scale`), `chunkBase` uniform (global index = `chunkBase + instance_index`). World centred at bounds centroid (float32 jitter). `geometry.boundingSphere` set manually from manifest chunk bounds (Three can't derive it; needed for frustum culling). `drawRange` per chunk = point-budget slider (0–100%). Point size (px) with perspective attenuation + min/max clamp. Note: WebGPU has no point size; Three renders sized `Points` as instanced quads → 4–6× vertex load, verified in phase 0 spike.
- `compute/` — WGSL passes + CPU worker equivalents.
- `edit/` — selection, ops, undo, export.
- `ui/` — control panel, perf/debug HUD, CSS modules. Theme via `theme` prop (or `data-theme` on ancestor) → CSS vars mirroring Lab tokens.

### Per-point state (`flags`)
u8 per point, packed 4/u32 in a storage buffer (bits: hidden, selected, deleted, splitA, splitB). CPU `Uint8Array` mirror is source of truth; after any edit, upload dirty range `[minIdx, maxIdx]` only. Hidden/deleted → vertex moved outside clip in shader (no compaction).

### Memory budget (20M)
| buffer | GPU | CPU |
|---|---|---|
| positions (8 B) | 160 MB | 160 MB (worker) |
| flags (u8) | 20 MB | 20 MB |
| normals (oct u32) | 80 MB | — |
| AO (u8→u32 packed) | 20 MB | — |
| undo ring | — | ≤256 MB cap |
~280 MB GPU, ~450 MB CPU worst case. OK on M1 unified; documented in README.

### Colormaps
256×1 LUT textures: height + intensity use continuous maps (viridis, turbo, grayscale); classification uses categorical ASPRS palette. Mode + LUT selectable in panel.

### Eye-dome lighting
Three `PostProcessing` + TSL `pass()` node (colour + depth). EDL shades each pixel by log-depth gradient to neighbours (Boucheny). Params: radius (px), strength. Toggle on/off. R3F frameloop set manual; `useFrame` calls `postProcessing.render()`.

### Camera
drei `OrbitControls`, auto-fit to manifest bounds on load, damping on.

## 3. GPU compute

All passes: TSL `storage()` nodes over Three attributes + `wgslFn` kernels, dispatched with Three's compute API on the renderer's device. No readback except where stated. Runs **on demand after load completes**, over all loaded points (per-chunk compute would seam at chunk borders).

1. `hash_build.wgsl` — cell key per point (cell = search radius), hashed to table of size T = next pow2 ≥ 2·N (collisions merge cells; distance test filters, no chaining). Histogram → prefix scan (reduce-then-scan, 3 dispatches) → scatter → sorted indices + cell start offsets.
2. `normals.wgsl` — per point: visit 27 neighbour cells, keep k=16 nearest (register insertion sort), covariance, smallest eigenvector via Jacobi 3×3, orient toward +Z; write oct-encoded normal (u32). Camera-facing flip done in vertex shader (`dot(n, viewDir) < 0`).
3. `ao.wgsl` — per point (needs normals): fraction of neighbours within radius above tangent plane → occlusion term.

Timing: Three `resolveTimestampsAsync(TimestampQuery.COMPUTE)` per pass (feature-detected). Shading modes: flat, normal-lit, normal-lit + AO.

### CPU benchmark path
Same algorithms in TS (typed arrays) in the loader worker. **Benchmark only, not a compat path.** Capped at 2M points (demo set, or first-N prefix of each chunk on the full set); progress + cancel. Debug panel table: pass × {GPU ms, CPU ms, N}. "Verify" button: runs both on the same N, reports max angular normal diff + AO MAE (correctness evidence for README).

## 4. Editing

- **Click select**: ID pass renders point index into `r32uint` target (24-bit RGB insufficient for 20M), scissored to a few px around cursor, respects hidden/deleted + point size; 1-px readback.
- **Lasso select**: polygon in screen space → GPU compute pass: project quantized positions with view-proj, point-in-polygon, write `selected` bit. Readback of the selected bitset (N/8 bytes) syncs the CPU mirror + feeds undo.
- **Ops**: isolate (hide non-selected), hide, delete, unhide-all, clear selection.
- **Split**: plane fitted to current selection (RANSAC inliers → least-squares refine); points above/below tagged splitA/splitB, coloured distinctly. Each side can then be isolated/deleted. No box gizmo.
- **Undo**: command pattern; each command stores `{ minIdx, maxIdx, prevFlags: Uint8Array slice }` (dense range diff, worst case N bytes). Ring: 30 deep **and** ≤256 MB total, evict oldest. Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z redo.
- **Export**: worker compacts non-deleted points → `points.bin` + `manifest.json` → `fflate` zip → single download.

## 5. Perf & docs

- HUD: frame ms (EMA), FPS, draw calls, loaded/total points, point budget %, last compute pass ms.
- README perf table (M1 baseline): load time, FPS at 2M / 10M / 20M (via budget slider on full set), normals + AO ms GPU vs CPU @2M, lasso ms, GPU memory.
- README: setup, data download + preprocess instructions, controls, screenshots/webm, perf table, memory budget.
- `docs/ARCHITECTURE.md`: data flow, point/manifest format, compute pipeline, editing/undo model. Updated each phase.

## 6. Testing

- vitest: manifest parse + Range/offset math, point unpack/dequant, undo ring (count + byte cap eviction), plane fit (RANSAC + LSQ on synthetic planes), CPU spatial hash + kNN vs brute force, export compaction + zip round-trip, point-in-polygon.
- pytest: preprocess round-trip on synthetic LAS (quantization error bound, chunk counts sum, offsets contiguous, manifest schema, unit conversion, `--stats`).
- Manual: browser smoke on demo dataset each phase; GPU-vs-CPU verify button.

## 7. Phases (one branch → merge to main each)

0. **scaffold + spike** — Vite/R3F/WebGPU hello, repo, MIT, pinned deps. Spike proves: `uint16x4` attribute renders; sized points (quad mechanism + cost at 2M synthetic); `wgslFn` compute writes a storage attribute Three then renders; timestamp query works. Findings → ARCHITECTURE.md. Any failure here revises this spec before phase 1.
1. **preprocess** — tools, `--stats`, packed bin + offsets, demo dataset, tests. Verify Range + CORS on release asset.
2. **viewer** — streaming, orbit, budget slider, point size, colormaps, flags buffer.
3. **edl** — post pass, params, toggle.
4. **compute** — hash, normals, AO, timing panel, CPU benchmark + verify.
5. **editing** — click/lasso select, ops, split, undo, export zip.
6. **perf-docs** — HUD numbers, README table, screenshots/webm, ARCHITECTURE, portfolio blurb.

## Out of scope (YAGNI)

Octree LOD, multi-tile mosaics, mesh reconstruction, server backend, mobile touch editing, WebGL fallback, split-box gizmo.
