# Point Cloud Editor — Design Spec

Date: 2026-09-15
Status: complete (2026-09-25)

## Goal

Clean-room WebGPU point cloud viewer/editor. Portfolio piece demonstrating production-grade real-time 3D: 5–20M point LiDAR, GPU compute (WGSL), editing ops, explicit perf numbers. Ships as a Lab experiment and 2026 portfolio entry.

## Hard constraints

- Written from scratch. Public techniques + public data only. No reference to any NDA material.
- Data: USGS 3DEP LiDAR. Tile priority: Los Angeles → Santa Barbara → San Francisco → NYC (by availability, must include building + vegetation classes; NYC 2017 is the safe fallback). Raw LAZ never committed.
- Stack (pinned, exact): `three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `vite@8.3.0`, TypeScript. Three via R3F on `WebGPURenderer`; compute kernels in raw WGSL via TSL `wgslFn` + `storage()` nodes (no internal backend API). Extra deps approved: `vitest`, `pytest`, `fflate` (export zip). `.npmrc`: `legacy-peer-deps=true` (fiber 9.7.0 peer range `react >=19 <19.3` excludes react 19.3.0) + `save-exact=true`. Debug panel hand-rolled (no leva). Python venv: laspy[lazrs], pyarrow, numpy, scipy.
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
Loaded as `Uint32Array` (2 words/pt, `x | y<<16`, `z | packed<<16`; words layout = disk bytes) into a `StorageInstancedBufferAttribute`; render reads it as a `uint32x2` instanced attribute and bit-unpacks (`x = w.x & 0xffff`, `y = w.x >> 16`, `z = w.y & 0xffff`, `cls = (w.y >> 24) & 0xff`); compute reads the same buffer as `array<vec2<u32>>`. Point index = `instanceIndex` in both stages. (`uint16x3` is not a WebGPU vertex format; `uint16x4` would block compute reads since WGSL has no u16.) Byte layout of `packed` identical to `[u8 intensity][u8 class]`.

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
- `render/` — R3F `<Canvas>` with `WebGPURenderer` constructed with `requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize }` (query `navigator.gpu.requestAdapter()` first; omit `requiredLimits` if adapter is null). The WebGPU default of 128 MiB caps a single storage binding at 16,777,216 pts (`N×8` B positions); passing the adapter's own limit unblocks 20M compute (verified phase 0; alternative: chunk storage bindings). One `THREE.Sprite` per chunk with `PointsNodeMaterial` (`sizeNode` = CSS px, `sizeAttenuation=false`) over a `PlaneGeometry` with the instanced `uint32x2` `qpos` attribute (`StorageInstancedBufferAttribute`, 2 words/pt), `dequant` uniform (`min`, `scale`), `chunkBase` uniform (global index = `chunkBase + instanceIndex`). World centred at bounds centroid (float32 jitter). `geometry.boundingBox/boundingSphere` set manually from manifest chunk bounds (Three can't derive it) **and** `sprite.intersectsFrustum` overridden to `frustum.intersectsObject(sprite)` — stock `Sprite` culling uses a unit sphere at the object origin and ignores geometry bounds (verified phase 0: off-screen → `tris 1`). Manual chunk visibility from manifest AABB vs frustum remains an option. `count` per chunk = point-budget slider (0–100%; instance count, since draw is 1 quad × N instances). Point size in px with min/max clamp (perspective attenuation via `sizeNode`, `sizeAttenuation` stays off). Mechanism note (phase 0): `THREE.Points` + `sizeNode` is always 1 px on WebGPU (`PointsNodeMaterial` docs); `PointsNodeMaterial` on a `Sprite` takes `setupVertexSprite` → true pixel size, 4 verts/pt (2 tris; `tris = 2N + 1`, the +1 is the renderer's output blit quad). `SpriteNodeMaterial.scaleNode` is world units × `-viewZ`, not px — don't use it for point size.
- `compute/` — WGSL passes + CPU worker equivalents.
- `edit/` — selection, ops, undo, export.
- `ui/` — control panel, perf/debug HUD, CSS modules. Theme via `theme` prop (or `data-theme` on ancestor) → CSS vars mirroring Lab tokens.

### Per-point state (`flags`)
u8 per point, packed 4/u32 in a storage buffer (bits: hidden, selected, deleted, splitA, splitB). CPU `Uint8Array` mirror is source of truth; after any edit, upload dirty range `[minIdx, maxIdx]` only. Hidden/deleted → vertex moved outside clip in shader (no compaction). Vertex read: `flags[idx >> 2] >> ((idx & 3) * 8) & 0xff`. Packed-u8 writes from compute are thread-per-word (dispatch `ceil(N/4)`, each thread stores one whole word) or `atomicOr`/`atomicAnd` on a `storage(...).toAtomic()` node; never plain per-byte stores. The same `storage()` node is bound `read_write` in compute and `read` in vertex automatically — do not call `toReadOnly()` on it (mutates the node).

### Memory budget (20M)
| buffer | GPU | CPU |
|---|---|---|
| positions (8 B) | 160 MB (152.6 MiB, computed phase 0) | 160 MB (worker) |
| flags (u8, packed 4/u32) | 20 MB (19.1 MiB, computed phase 0) | 20 MB |
| normals (oct u32) | 80 MB (est.) | — |
| AO (u8→u32 packed) | 20 MB (est.) | — |
| undo ring | — | ≤256 MB cap |
Phase 0 measured at 20M: computed GPU buffers 171.7 MiB (pos + flags); GPU-process RSS delta +77.4 MiB as a loose proxy (unified memory, not a VRAM reading). Projected with normals + AO ~280 MB GPU, ~450 MB CPU worst case. OK on M4 Max unified; documented in README.

### Colormaps
256×1 LUT textures: height + intensity use continuous maps (viridis, turbo, grayscale); classification uses categorical ASPRS palette. Mode + LUT selectable in panel.

### Eye-dome lighting
Three `PostProcessing` + TSL `pass()` node (colour + depth). EDL shades each pixel by log-depth gradient to neighbours (Boucheny). Params: radius (px), strength. Toggle on/off. R3F frameloop set manual; `useFrame` calls `postProcessing.render()`.

### Camera
drei `OrbitControls`, auto-fit to manifest bounds on load, damping on.

## 3. GPU compute

All passes: TSL `storage()` nodes over Three attributes + raw WGSL `wgslFn` kernels with `ptr<storage, array<T>, read_write>` params (verified phase 0; no pure-TSL fallback needed), dispatched with Three's compute API on the renderer's device. Kernel rule: every `wgslFn` kernel entry **returns a value and is `.toVar()`-ed** (or the store is done in TSL: `flags.element(i).assign(wgslFn(...))`) — void `wgslFn` calls are silently dropped by three 0.186 (`FunctionCallNode` never emits its own statement). Storage params are passed as a named object; the point/word index is `instanceIndex` (= `globalId.x`). No readback except where stated. Runs **on demand after load completes**, over all loaded points (per-chunk compute would seam at chunk borders).

1. `hash_build.wgsl` — cell key per point (cell = search radius), hashed to table of size T = next pow2 ≥ 2·N (collisions merge cells; distance test filters, no chaining). Histogram → prefix scan (reduce-then-scan, 3 dispatches) → scatter → sorted indices + cell start offsets.
2. `normals.wgsl` — per point: visit 27 neighbour cells, keep k=16 nearest (register insertion sort), covariance, smallest eigenvector via Jacobi 3×3, orient toward +Z; write oct-encoded normal (u32). Camera-facing flip done in vertex shader (`dot(n, viewDir) < 0`).
3. `ao.wgsl` — per point (needs normals): fraction of neighbours within radius above tangent plane → occlusion term.

Timing: Three `resolveTimestampsAsync(TimestampQuery.COMPUTE)` per pass (`timestamp-query` available on the target machine, verified phase 0; feature-detect anyway; requires `trackTimestamp: true` at renderer construction). `computeAsync` does not await GPU completion — its CPU time is labelled "submit", the GPU number comes only from the timestamp resolve (Metal quantises to ~0.066 ms steps). Shading modes: flat, normal-lit, normal-lit + AO.

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

- HUD: frame ms (EMA), FPS, draw calls, loaded/total points, point budget %, last compute pass ms. `renderer.info.autoReset=false` and reset after reading (three's internal rAF races r3f's loop); `draws` floor is 1 / `tris` +1 from the WebGPURenderer output blit.
- README perf table (M4 Max baseline; spike row pre-filled from phase 0: 2M ~5–6 ms / ~160–200 fps, 10M 25 ms / 41 fps, 20M 65 ms / 15 fps at size 3, synthetic, DPR 1): load time, FPS at 2M / 10M / 20M (via budget slider on full set), normals + AO ms GPU vs CPU @2M, lasso ms, GPU memory.
- README: setup, data download + preprocess instructions, controls, screenshots/webm, perf table, memory budget.
- `docs/ARCHITECTURE.md`: data flow, point/manifest format, compute pipeline, editing/undo model. Updated each phase.

## 6. Testing

- vitest: manifest parse + Range/offset math, point unpack/dequant, undo ring (count + byte cap eviction), plane fit (RANSAC + LSQ on synthetic planes), CPU spatial hash + kNN vs brute force, export compaction + zip round-trip, point-in-polygon.
- pytest: preprocess round-trip on synthetic LAS (quantization error bound, chunk counts sum, offsets contiguous, manifest schema, unit conversion, `--stats`).
- Manual: browser smoke on demo dataset each phase; GPU-vs-CPU verify button.

## 7. Phases (one branch → merge to main each)

0. **scaffold + spike** — Vite/R3F/WebGPU hello, repo, MIT, pinned deps. Spike proved: `uint32x2` packed attribute renders; sized points (Sprite quad mechanism, 4 verts/pt, cost at 2M/10M/20M synthetic); `wgslFn` compute writes a storage attribute Three then renders; timestamp query works; `requiredLimits` needed above 2^24 pts. Findings → ARCHITECTURE.md; this spec amended accordingly. **Done.**
1. **preprocess** — tools, `--stats`, packed bin + offsets, demo dataset, tests. Verify Range + CORS on release asset. **Done.**
2. **viewer** — streaming, orbit, budget slider, point size, colormaps, flags buffer. **Done.**
3. **edl** — post pass, params, toggle. **Done.**
4. **compute** — hash, normals, AO, timing panel, CPU benchmark + verify. **Done.**
5. **editing** — click/lasso select, ops, split, undo, export zip. **Done.**
6. **perf-docs** — HUD numbers, README table, screenshots/webm, ARCHITECTURE, portfolio blurb. **Done.**

## Amendments (phase 1–6 brainstorm, 2026-09-15)

Per-phase specs live in `2026-09-15-phase-N-*-design.md` and refine this document. Where they differ, the following amendments win:

- **A1 Demo hosting.** Both demo and full set are GitHub Release assets (`v0.1-data`); `public/data/` is gitignored; `npm run data:demo` / `data:full` (zero-dep node script) fetch them. Supersedes "Demo lives in `public/data/demo/`" in §1.
- **A2 Click pick is a compute pass**, sharing the lasso projection kernel: dispatch 1 `atomicMin` on quantized depth among points within `r` px of the cursor, dispatch 2 writes the index of the point at that depth, 8-byte readback. Supersedes the ID render pass in §4.
- **A3 One global `qpos` storage buffer** (`StorageBufferAttribute`, N × 2 u32) allocated at manifest load, chunks uploaded by range (`addUpdateRange`). Per-chunk Sprites read positions in the vertex stage via `qpos.element(userData('chunkBase') + instanceIndex)`; no per-chunk attribute. Compute passes run over the whole buffer. Supersedes the per-chunk `StorageInstancedBufferAttribute` in §2.
- **A4 Hash table size** `T = nextPow2(max(1024, N / 8))`, not `2·N` (at 20M the latter costs ~540 MB for two tables). Collisions merge cells; the distance test filters. 20M GPU budget becomes ~380 MB including sorted indices, normals, AO and cell tables (Phase 4 spec table).
- **A5 Flags sync** after a GPU select reads back the whole flags buffer (N bytes) into the CPU mirror, not an extracted bitset.
- **A6 CPU copy.** The main-thread `Uint32Array` backing the `qpos` attribute is the only persistent CPU copy (160 MB at 20M). The loader worker keeps nothing; CPU benchmark and export receive a transient copy on demand. Supersedes "worker owns the CPU copy" in §2. Memory table: CPU = 160 MB main + 20 MB flags mirror + transient copies.
- **A7 State + deps.** Viewer state is a hand-rolled store on `useSyncExternalStore` (no zustand). Python deps: `laspy[lazrs]`, `numpy`, `pytest` only (pyarrow, scipy dropped).
- **A8 Hidden/deleted points collapse the quad**, `sizeNode = 0`, instead of "vertex moved outside clip" (§2). A point pushed to a huge coordinate projects to a finite vanishing point (`clip.xy / clip.w` stays bounded) and is only culled when it lands behind the camera or beyond the far plane in f32, so it is not a reliable hide. A zero-size sprite quad rasterises no fragments regardless of camera. (Spec review, 2026-09-15.)
- **A9 Compute dispatch.** three 0.186 already splits a numeric `.compute(N, [64])` count above `maxComputeWorkgroupsPerDimension` (65,535) into a 2D dispatch and linearises `instanceIndex` across `globalId.xyz` (`WGSLNodeBuilder` compute prologue, `WebGPUBackend.compute`). Kernels use `instanceIndex` with an `i ≥ N` guard; no hand-rolled 2D indexing (Phase 4 spec). (Spec review, 2026-09-15.)

- **A10 Data source: City of Vancouver LiDAR 2022**, not USGS 3DEP. Vetting on 2026-09-15 showed every 3DEP candidate (LA 2016, SF 2024, NYC Sandy 2013; NYC 2017 is not in the TNM LPC catalogue) carries only the 3DEP baseline classes (1, 2, 7, 9, 17, 18): building and vegetation classification is a project-specific extra the "Hard constraints" assumed. Vancouver 2022 is open data (Open Government Licence – Vancouver, attribution required), ~49 pts/m², 1 km tiles, LAS zipped, classified as unclassified / ground / low veg / high veg / water / building / other / noise, UTM 10N NAD83(CSRS) metres, CGVD28 metres. Tile: `491000_5458000` (downtown), subsampled to 20M. The file host (`webtransfer.vancouver.ca`) sits behind a Cloudflare browser challenge that rejects scripted requests, so the tile download is a one-time browser step; `fetch.py` lists tiles through the open-data API and imports a downloaded zip. Supersedes "Data: USGS 3DEP" in Hard constraints and the TNM discovery path in the Phase 1 spec.

- **A11 Normal quality & lighting (phase 4b).** The normals kernel drops the `K = 16` nearest-neighbour cap for a single-pass centred covariance over every neighbour within `radius` (`Σd`, `Σddᵀ`, count; degenerate at `n < 4`); default radius rises to **6 × spacing** (slider 2–10×, was 3× and 1–6×) — at 20M density the old cap sat within ~0.5 m of any point regardless of the slider, making the radius control a no-op for facade normal quality. Lighting becomes `light = 0.30 + 0.45·|n·v| + 0.25·max(n·L, 0)` (wrap + fixed sun, `L = normalize(−0.4, −0.3, 0.85)`, world +Z up) with `lit + AO` applying `sqrt(ao)` instead of `× ao`; a fourth `normals` debug shading mode colours `|n_world|` directly. A smoothing pass (a second compute pass + a second `normals`-sized buffer, +80 MB at 20M) was designed and costed, then dropped: radius PCA plus the 6× default alone clears the class-6 `|n.z|` wall-bin acceptance bar (≥ 0.10 @2M, ≥ 0.07 @20M) at normals/AO costs of 34–36/46 ms (2M) and 630/685 ms (20M). Supersedes the `K = 16` kNN estimator and the headlight lighting model in the Phase 4 spec (`2026-09-15-phase-4-compute-design.md`, §"Passes"/§"Parameters"/§"UI"). (2026-09-18)

- **A12 Lab integration = proxy + iframe** (phase 6 spec P6-1): the app deploys as its own Vercel project under `/point-cloud/app/`, and the Lab proxies that path and iframes it. Data comes from a build-time fetch of the release assets (P6-2). (Numbered A12 because A11 is already taken by phase 4b.)

## Out of scope (YAGNI)

Octree LOD, multi-tile mosaics, mesh reconstruction, server backend, mobile touch editing, WebGL fallback, split-box gizmo.
