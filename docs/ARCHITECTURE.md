# Architecture

## Overview

```
 Vancouver LiDAR 2022 tile (LAS, 51.5M pts)
        │  tools/preprocess.py  (quantise, chunk, subsample → 20M full + 2M demo)
        ▼
 GitHub release v0.1-data  {demo,full}-{manifest.json,points.bin}
        │  scripts/fetch-data.mjs  (npm run data:*; on Vercel: npm run build:vercel)
        ▼
 public/data/<name>/{manifest.json,points.bin}   ── served same-origin under /point-cloud/app/
        │  loader.worker.ts  (HTTP Range per chunk; single-fetch fallback on 200)
        ▼
 storage buffers: qpos (8 B/pt) · flags (1 B/pt)          CPU: flags mirror (Uint8Array)
        │
        ├─► render   ChunkSprites (256 sprite draws, TSL colour/shading) → PostPass (EDL) → canvas
        ├─► compute  hash: count → scan → scatter  →  normals (radius PCA)  →  ao
        │            writes normals · ao; read back only by verify
        └─► edit     pick / lasso kernels (GPU) · isolate / hide / delete / split / undo (mirror → upload)
                         │
                         ▼
                     export: loader worker compacts + zips → export.zip (same manifest/bin layout)
```

`src/viewer/` holds the component; `src/App.tsx` + `src/harness.ts` are the page around it (URL params, `?bench=1` handle, theme messages).

## Deferred

Known gaps carried across phases. Each entry names the owner phase (or "any") and what triggers the fix.

**Hosting / embedding**
- Decided in phase 6 (§ Bench and deploy): the app is its own Vercel project and fetches both datasets at build time, so the browser never touches the CORS-less release URLs. The Lab proxies `/point-cloud/app/*` to it, same-origin. `check_hosting.py --no-cors` passes locally (`vite preview`, § Bench and deploy › Hosting). **Pending the user** (Vercel project creation, Lab push): `check_hosting.py --no-cors` against the project URL and the Lab-proxied full bin, and the Lab production check (page loads, theme toggle without a second manifest fetch). Record both results in § Bench and deploy › Hosting.
- The release-URL acceptance lines ("passes on both bins", Phase 2 "full set streams with 206 from the release URL") stay unmet by design. The browser only ever loads same-origin data.
- Data under `/point-cloud/app/data/` is served `immutable` for a year at unversioned paths. A changed dataset needs a new folder name (or release tag), or clients keep the old bytes. Owner: any (next data change).

**Renderer / GPU lifetime**
- r3f 9.7 never calls `gl.dispose()` on a `WebGPURenderer` at `<Canvas>` unmount; renderer + `qpos`/`flags` buffers live until page unload (see "GPU lifetime"). Owner: any (whichever phase adds remount/dataset switching; Phase 5 export re-open is a fresh page load by ruling 7, so it does not exercise this). Phase 4 adds ~214 MB of compute buffers to the same leak.
- `RenderPipeline` + its pass target (Phase 3) join the renderer leak: `PostHandle.dispose()` disposes both on `<PostPass>` unmount, but the renderer itself is never disposed, so in practice neither ever runs today (no unmount path in the app). Owner: same as above.
- `DatasetLimitCheck` reads `renderer.backend.device.limits` — a second backend read beyond the `compatibilityMode` one the spec allows. Replace with `renderer.getDevice?.()`/adapter limits captured in the factory if three exposes one. Owner: any.
- `<Scene>` has no `key={manifestUrl}`; the cached renderer + `DatasetLimitCheck` handle a manifest swap, but sprites/material are rebuilt through `loaded` identity only. Owner: any (export re-open is a fresh page load).

**Loader**
- After ≥1 chunk uploaded, a worker `error` leaves `status` at `'loading'` forever (only `error` text is set; the loading card gates on `!error` as well, so it hides). Owner: any UI that needs a real terminal state.
- `url` is not re-synced to a fresh `response.url` after an origin retry; the discovery fetch is not retried; a mid-flight abort is untested; sibling workers are not cancelled on a chunk error. All cost/coverage only.
- `loader.worker.ts` `if (msg.pos)` seeding and the worker entry have no unit test (module workers aren't testable under the node vitest env); browser-verified via the first-five-chunk log.
- `validateManifest` accepts `count ≤ 0`, non-integers and `pointCount === 0` (→ `storage(..., 0)`).

**Viewer UI**
- ~~`id="hud"` on the viewer root child duplicates with several viewers on one page.~~ **Done (phase 6)**: the HUD element is `data-pcv-hud`, and scripted checks read the bench handle (`frame()`, `state()`), not the DOM.
- No unit tests for `Panel`, `useLoader`; `ASPRS_FALLBACK` is named in the Phase 2 Interfaces but the code uses `ASPRS_COLORS[-1]`.
- `dpr?: number` on `PointCloudViewer` (Phase 3, `?dpr=` on the dev harness, clamped `[0.5, 4]`) exists to drive perf-row measurement (DPR 2 numbers below) without editing source; not exercised as a public embedding API beyond that.

**Post-processing**
- ~~20M EDL cost at 100 % budget sits below the HUD EMA's ±1 ms toggle-to-toggle noise; a GPU timestamp query around the pipeline's `render()` would give a real per-pass number.~~ **Done (phase 6)**: `renderGpuMs` (render-pass timestamp query, `render/PostPass.tsx`). It exceeds the frame time at 10M/20M, see § Bench and deploy.
- `PCFSoftShadowMap has been removed` fires once per `renderer.setSize` (every resize and every `dpr` change), on top of the one-time Phase 2 warning; pre-existing r3f default shadow config, benign, could be silenced with an explicit `shadows={false}` on `<Canvas>`. Owner: any.

**Compute (Phase 4)**
- Hash buffers (`cellStart` 16.8 MB, `cellCursor` 16.8 MB, `blockSums`, `sorted` 80 MB at 20M) stay allocated after a build (three has no API to free a `StorageBufferAttribute`'s GPU buffer; `Node.dispose()` only emits an event). Rebuilds reuse them; with `normals` 80 MB + `ao` 20 MB they are the ~214 MB the renderer-leak entry above counts. Owner: same as the renderer leak.
- Verify is disabled above `BENCH_CAP` (2M): the CPU bench runs a per-chunk prefix subsample there, whose neighbourhoods differ from the full set, so the readbacks are not comparable. A same-subset GPU build (or a full 20M CPU run, ~2.5 min extrapolated) would enable it. Owner: any.
- `scanBlockSums` is a single-thread serial loop over `T/256` block sums (16,384 at 20M; 1.70 ms for the whole scan row) — the serial floor if `T` grows past 2²². Owner: any larger tile.
- Build wall time exceeds the GPU sum by ~35–50 ms at 2M and ~950 ms at 20M (each `timedCompute` awaits `computeAsync` then `resolveTimestampsAsync`, interleaved with 35 ms render frames); the panel shows both, only `gpu` is the kernel cost. A single command encoder for all passes would close the gap. Owner: any (out of scope for phase 6, P6-10).
- StrictMode mounts `<ComputeRunner>` twice; the first pipeline's hash buffers linger until unload in DEV only (same `dispose()` limitation).
- CPU bench pins the loader worker (~11 s at 2M, 14.5 s for the 20M subsample); a `dispose` during a bench terminates the worker and the pending promise resolves `null`.
- Panel "Benchmark (CPU, N pts)" title shows `min(total, BENCH_CAP)` = 2,000,000 on the full set while the actual subsample is 1,999,872 (256 × floor(2M/256)); the table row uses the real `bench.n`.

**Editing (Phase 5)**
- 20M lasso readback (`getArrayBufferAsync(flags)`, 20 MB) measured 135–173 ms in phase 5, above the spec's 100 ms fallback trigger. The phase 6 bench row reads 80.7 ms (earlier range not reproduced, cause unknown). The partial-range fallback (`getArrayBufferAsync(attr, null, offset, count)` over the polygon's visible index range) is unsound for replace mode — the kernel clears `selected`/split bits over the whole buffer — so the full readback stays; a bbox-limited add/subtract path would still need the whole-buffer clear on replace. Owner: any.
- `pick.ms` (HUD/toolbar `pick ms`) is wall time from `resetPick` submit to the 8-byte readback, so at 20M it is 15–146 ms of queue wait behind in-flight 33 ms render frames plus two 20M-thread passes, not kernel cost (2.1 ms at 2M). A `timedCompute` variant would isolate the GPU part. Owner: any (phase 6 publishes the wall number, median of 5).
- `pickDepth` / `pickIndex` share 12 duplicated WGSL lines (guards, decode, project, radius, distance); only the last statement differs. Owner: any.
- `Scene ↔ EditRunner` import cycle: `EditRunner` imports `homePose` from `Scene.tsx`, which mounts `<EditRunner>`; `homePose` is called at pick time only (same pattern as `useLoader`), harmless under Vite/ESM but a lint trap. Move `homePose` to `render/camera.ts`. Owner: any.
- Undoing a `split` restores the flag bytes but leaves `edit.split.fitted = true` / `inlierRatio` and the chosen `splitSide` (verified at 20M: after undo the store still reads `fitted: true, inlierRatio 0.053`), so a following side-A op runs against an empty set. `undo()`/`redo()` should reset `edit.split` (or rederive `fitted` from the bytes). Owner: any.
- `editor.split()`'s `selectedPositions` is two full-N scans over the mirror (count, then fill a `Float32Array` of selected positions) before the 50k sample is drawn — 489 ms wall for a 16.8M-point selection at 20M (the fit itself is 200 RANSAC iterations on 50k points). A reservoir sample in the scan loop would drop the arrays. Owner: any.
- The toolbar (bottom-left) overlaps the Panel's bottom rows (HUD checkbox) below ≈ 860 px viewport height. Owner: any (phase 6 did not change the layout).
- 20M export peak worker memory is unverified: the worker holds the transferred `qpos` (160 MB) + flags (20 MB) copies, the compacted output (≤ 160 MB) and the zip (same size, stored), ≈ 3 × 160 MB transiently; measured only as wall time (398 ms for 17.4M points). Owner: any.
- ~~The DEV handle (`__pcvEdit.api.exportZip`) can export while `status === 'loading'` and would zip zeros for chunks not yet uploaded; the toolbar gates Export on `ready`.~~ **Stale**: no `__pcvEdit` global exists; the bench handle (`window.__pcv`) exposes no `exportZip`, and `api.exportZip` is reachable only from the Toolbar's Export button, disabled until `status === 'ready'` (set only after every chunk uploads) — the race is not reachable today. Owner: any (revisit if `exportZip` is ever exposed on the bench handle before `ready`).

**Bench handle (Phase 6)**
- `runAll({ skipCpu: false })` runs the CPU bench twice, because `verify()` re-runs it after `cpuBench()`. The runbook avoids this (`skipCpu: true`, then separate `cpuBench()` / `verify()` evaluates). Owner: any.
- `lasso()` / `pick()` return the previous store values (`gpuMs`, `readbackMs`, `pickMs`, `selected`) when the api call returns early (not ready, busy). Owner: any.
- The `onApi` effect in `PointCloudViewer.tsx` has no cleanup, so a host that keeps a handle across a dataset switch holds a stale one. Owner: any (with dataset switching).
- `api.orbit` (`render/Scene.tsx`) has no cancellation: an unmount mid-orbit leaves its step loop moving the camera until it finishes. Bench-only. Owner: any.

**Tools (Phase 1)**
- `check_hosting.walk()` has only a DNS-failure test (no local-http-server redirect test); `evaluate([])` raises; hop-cap exhaustion is silent.
- `--stats` zero-intensity "no division warning" is not asserted; `rec.astype("<u2")` makes a redundant 160 MB copy; the DNS-failure test does a live `.invalid` lookup (slow on sandboxed resolvers).
- `--import` derives the tile URL from the zip stem (`--url` overrides); a malformed zip prints a raw traceback.

## Bench and deploy (phase 6)

Spec: `docs/superpowers/specs/2026-09-15-phase-6-perf-docs-design.md` (Amendments P6-1–P6-10). Runbook: `scripts/bench.md`. Rows: `docs/bench/2026-09-25-m4max.json`.

Label change against the sections below: the phase 6 numbers are from **Chrome 153 via Playwright MCP (headed)** on a **120 Hz** display (8.33 ms vsync floor; an empty rAF loop measures 8.30 ms). Phases 0–5 say "headless Chromium" for the same Playwright MCP setup, which was in fact headed, and they were measured on a 240 Hz display (4.17 ms floor). Their numbers are left as recorded.

### Bench handle (`bench/handle.ts`)
- `PointCloudViewer` takes `onApi?: (h: BenchHandle) => void`. Once per loaded dataset it calls `onApi` with `createBenchHandle(store, api, editor)`. The harness (`src/App.tsx`) sets `window.__pcv` only under `?bench=1`. `src/viewer/` parses no URL and sets no global: zero `__pcv` and zero `import.meta.env.DEV` under it.
- Everything else the handle needs is a bench-only slot on `ViewerApi` (`classStats`, `renderGpuMs`, `frame`, `orbit`, `uploadLog`, `canvas`, and `cpuPick` / `cpuLasso` from `createCpuReference` in `bench/cpuReference.ts`, the CPU references for the GPU kernels). Each producer installs its slot on mount and clears it on unmount; the handle reads `api.*` lazily, so one built before `<Scene>` mounts still works.
- `handle.ts` is a pure module (type-only imports of three-facing code) with vitest coverage in `handle.test.ts`. `memoryBytes(pointCount)` is the computed-memory formula: `qpos` 8 B/pt, `flags` and `ao` `ceil(N/4)×4` B, `normals` 4 B/pt, and the hash (`cellStart` T+1, `cellCursor` T, `blockSums` T/256, `sorted` N; 4 B each).
- `runAll` runs in the page: one `browser_evaluate` per dataset produces a whole row. There is no external polling while 160 MB streams (the Playwright tab crashes, and the console buffer caps around 184 entries), and there is no MCP round-trip inside a timed interval. The sequence is settle → frame → `orbit` → frame → EDL off/on → `renderGpuMs` → `compute` → lasso (vs `cpuLasso`) → 5 picks. `cpuBench()` and `verify()` take about 15 s each at 2M, so the runbook calls them in their own evaluates (`skipCpu: true`) to stay under the MCP timeout.

### `renderGpuMs` (`render/PostPass.tsx`)
- It waits one rAF, then `resolveTimestampsAsync(TimestampQuery.RENDER)`. three's `WebGPUTimestampQueryPool._resolveQueries` groups queries by their `:f<frame>` uid suffix and returns the total for the last frame id; that id is ticked by three's own internal animation loop, not by r3f's render calls, so the value covers whatever render-pass timestamps landed under the most recently ticked frame id, not necessarily exactly one r3f frame's passes.
- Measured: 6.95 / 25.49 / 52.82 ms (2M / 10M / 20M) against frames of 8.35 / 16.77 / 33.74 ms. At 10M and 20M the sum exceeds the frame time. The cause is not established. Two plausible, unverified causes: a pass's begin/end interval overlaps neighbouring work on the tile-based GPU, or — below 60 fps — three's frame id and r3f's renders drift, so one frame id can cover more than one frame's passes. So use it to compare runs, and do not add it to frame time.

### Measured (2026-09-25)
The rows are in the JSON (the README tables are generated from it). Against the earlier sections:

| quantity | phase 6 row | earlier | reading |
|---|---|---|---|
| 2M frame | 8.37 → 8.35 ms | 4.17 ms | display vsync (120 vs 240 Hz), not a regression |
| 20M frame, home pose (100 %) | 33.19 ms | 33.2–33.3 ms (phase 5) | same |
| 20M EDL off / on (100 %; 50 %) | 34.12 / 33.73; 16.72 / 16.09 ms | 33.7 / 33.0; 17.1 / 17.4 ms (phase 3) | still inside noise |
| 2M compute total | 81.85 ms | 80–83 ms | same |
| 20M hash (count + scan + scatter) | 4.92 ms (10M row: 12.52) | 9.05 ms | one sample each; scatter swings 2.2–9.8 ms |
| 20M ao | 570.88 ms (10M row: 583.01) | 685 ms | faster in both rows; cause unknown |
| 2M verify max | 32.27° at 6× | 81.23° at 3× | radius change, not a regression |
| 2M CPU hash | 26.8 ms | 17–19 ms | one sample |
| 20M lasso flags readback | 80.7 ms | 135–173 ms (phase 5) | not reproduced, cause unknown |
| 20M pick, wall | median 113 ms (21–122) | 37–146 ms, mean 96 | same queue-wait regime |

- A dev-server smoke row taken with other tabs open read 142 ms for the 2M compute total, against 81.85 ms in a clean browser. The runbook now closes every other tab first.
- The 2M `cpuBench`, `verify` and `rssDeltaKB` come from the first demo load of the session (viewport 1277×804). The rest of the row is from a re-run at 1277×860. None of those three depend on the viewport.

### Hosting (`vercel.json`, `vite.config.ts`)
- The standalone Vercel project is `point-cloud-editor`. `buildCommand` is `npm run build:vercel` (`data:demo` + `data:full` + `build`, so both datasets are fetched at build time), output `dist`. `base` is `/point-cloud/app/` in dev, preview and build alike.
- Vercel serves `dist/` at `/`, so a rewrite maps `/point-cloud/app/:path*` → `/:path*`. Responses under `/point-cloud/app/data/` carry `Cache-Control: public, max-age=31536000, immutable` and `Access-Control-Allow-Origin: https://lab.merttoka.com`.
- In the Lab repo, `vercel.json` routes a 308 from `/point-cloud/app` to `/point-cloud/app/`, then the proxy `/point-cloud/app/(.*)` → the project, both ahead of `{ "handle": "filesystem" }`. The `/point-cloud` page renders the Lab header and a full-height iframe (`?theme=` at mount, then `postMessage({ type: 'pcv-theme' })`, which `themeFromMessage` in `src/harness.ts` accepts from its own origin only). That commit is made but not pushed. The proxy gives the Vercel host same-origin trust on `lab.merttoka.com`, so the project must exist and be owned before the Lab push.
- `check_hosting.py --no-cors http://localhost:4173/point-cloud/app/data/demo/points.bin` (`vite preview`): `range 206` PASS, `content-range` PASS (`bytes 0-15/16000000`, 16 B body), `accept-ranges` PASS. Production runs (project URL, Lab proxy) are pending; see Deferred.

### Media (`docs/media/`)
- `record(seconds)` records `canvas.captureStream(30)` with `MediaRecorder` (VP9) and downloads the result. The hero script (`scripts/bench.md` § Media) orbits, lassoes, splits and toggles EDL over 12 s: 4.28 MB raw at 1280×720, 30 fps.
- ffmpeg (`-an`) turns that into `hero.webm` (VP9 1.5 Mb/s, 1.97 MB) and `hero.mp4` (x264 CRF 23, 0.69 MB, Safari fallback).
- The PNGs (`overview`, `classification`, `normals-ao`, `lasso`, `split`) are `browser_take_screenshot` captures at 1280×720, DPR 1.
- The hero's scripted lasso selects about 96 % of the points, so the split shot is mostly one side. `split.png` is the clearer view.

## Viewer (phase 2)

Machine: Apple M4 Max, macOS 25.6.0, Chromium (Playwright MCP), Vite dev server on `localhost:5173`. Demo manifest: 2,000,000 pts / 256 chunks, 16 MB `points.bin`. Full manifest: 20,000,000 pts / 256 chunks, 160 MB `points.bin` (`npm run data:full`; already present for this task, 160,000,000-byte `points.bin` verified via `ls -l`).

### Loader (`src/viewer/loader/`)

`useLoader` fetches the manifest on the main thread, allocates `PointBuffers`/`PointMaterialHandle` sized to `manifest.pointCount`, then spawns `loader.worker.ts` (a module `Worker`) and posts a `start` message carrying `binUrl`, the per-chunk `ChunkRef[]` (centred `centre` for distance sort), and a seeded initial camera `pos` — `homePose(manifest).pos` (exported from `Scene.tsx`: `normalize(1, -1, 0.8)` times the fit distance for the 50° home fov), the same pose `CameraRig.fit` frames the dataset from — so `ChunkQueue.pop()` is sorted for that camera from chunk 1 instead of defaulting to `[0, 0, 0]`. First 5 chunk indices **before** seeding (default cam `[0,0,0]`, nearest to bounds centre, Task 5): `119, 135, 151, 118, 120`. After seeding — demo (2M): `15, 14, 31, 30, 13`; full (20M): `13, 12, 15, 14, 31`. Both land in the large-x/small-y corner of the bounds (chunk centres x≈491,860–491,980 of a 491,000–492,000 range, y≈5,458,032–5,458,096 of a 5,458,000–5,459,000 range) — matches the seeded camera direction `(1, -1, 0.8)`. The worker also accepts throttled `camera` messages (re-sorts the queue) and `dispose` (aborts in-flight fetches).

Inside the worker, `fetchAll` (`fetchChunks.ts`) fetches the first chunk alone to decide the mode: a `206` + `Content-Range` response means Range is supported, and its `response.url` (post-redirect — e.g. past a GitHub Release `302`) is reused as the base URL for every subsequent chunk request instead of `binUrl`, skipping the redirect hop per chunk; if a request against that reused URL later fails (e.g. a time-limited signed asset URL expiring), the loader retries once against the original `binUrl` before giving up. A `200` without `Content-Range` means Range isn't supported: the loader fetches the whole file once and slices every remaining chunk out of it locally, rather than re-fetching per chunk. Once the first chunk resolves the mode, a pool of `concurrency` (default 4) workers drains the priority queue; each chunk's `ArrayBuffer` transfers back to the main thread (`postMessage(..., [words.buffer])`, zero-copy).

Load timing (Task 5, demo 2M/256 chunks, warm local dev server on `localhost`): first non-zero `loaded` at **135 ms** (sample `1,362,301/2,000,000`; acceptance < 1 s), full `loaded 2,000,000/2,000,000` at **363 ms** (< 400 ms; acceptance < 3 s) — full demo load finishes well under half a second on localhost.

### Buffers and upload path (`render/PointBuffers.ts`)

One global `qpos` `StorageBufferAttribute` (`Uint32Array`, N×2 words) and one `flags` `StorageBufferAttribute` (`ceil(N/4)` words), allocated once at manifest load — not one attribute per chunk (spec A3). `uploadRange(offset, words)` does `qpos.array.set(words, offset*2)` then `qpos.addUpdateRange(offset*2, words.length)` + `needsUpdate = true`: a true partial-range copy, not a full-buffer re-upload (confirmed below). The main-thread `Uint32Array` backing `qpos` is the only persistent CPU copy of point data (spec A6); the loader worker keeps nothing once a chunk's buffer transfers out.

- **Per-chunk CPU upload cost** (the `array.set` + `addUpdateRange` call only, not the GPU upload which three does lazily on the next render; measured via dev-only `window.__pcvUploadMs`, read with `browser_evaluate`):
  - 2M (256 chunks, ~7.8k pts/chunk): n=256, median 0.000 ms, max 0.100 ms.
  - 20M (256 chunks, ~78k pts/chunk): n=256, median 0.000 ms, max 0.200 ms.
  - Sub-millisecond at both scales, scaling with per-chunk byte size rather than total buffer size — confirms `uploadRange` does a true partial-range copy, not a full-buffer `.set()`.
- **One-time first-upload frame**: the first `needsUpdate` after data starts arriving still pays one single large frame (upload + pipeline/bind-group creation, not per-chunk cost) — **216 ms** at 2M, **187 ms** at 20M; every later per-chunk upload folds into ordinary partial-range writes with no separate frame-time spike (a full-buffer 16 MB/160 MB re-upload per chunk would instead show ~256 repeated multi-ms spikes, not one).

### Material (`render/pointMaterial.ts`)

One shared `PointsNodeMaterial` across every chunk sprite. Global point index = `userData('chunkBase').add(instanceIndex)`, computed once per vertex; `qposNode.element(gi)` and `flagsNode.element(gi >> 2)` are **storage-buffer reads done in the vertex stage** (not compute) — bit-unpacked the same way compute would (`x/y/z` from `qpos`, `intensity`/`class` from its high word, hidden/deleted flag byte from `flags`). Colour `t` (chosen per `colorMode`: height/intensity/class) is derived from those same vertex-stage reads and wrapped in `vertexStage(t)` before the LUT `texture()` lookup — `vertexStage` pins the storage reads (and the value derived from them) to the vertex stage so the colour node evaluates once per vertex, not per fragment. `sizeNode = select(collapsed, 0, sizePx)`: hidden/deleted points (`FLAG_HIDDEN|FLAG_DELETED`) get size 0, collapsing the sprite quad to zero fragments (spec A8) rather than relying on off-screen translation, which isn't a reliable hide at f32 clip precision. LUT textures (`render/colormaps.ts`) are `DataTexture`s with `colorSpace = SRGBColorSpace` — values are authored as sRGB bytes and decoded on sample. The turbo polynomial's blue-channel `TB2` coefficient was corrected from `41.04993063` to `27.34824973` (commit `90c3934`) — the original value produced a wrong blue curve, caught by the colormap test threshold.

### Chunk sprites (`render/ChunkSprites.tsx`)

One `THREE.Sprite` per chunk, all sharing the one `PointsNodeMaterial`, but each gets its **own** `PlaneGeometry` purely to carry a manually-set `boundingBox`/`boundingSphere` from that chunk's manifest AABB (three can't derive point-cloud bounds itself). `Sprite.intersectsFrustum` is overridden to `frustum.intersectsObject(sprite)` — stock `Sprite` culling (`frustum.intersectsSprite`) checks a unit sphere at the object origin and ignores geometry bounds entirely (phase 0 finding: an off-screen chunk still drew `tris 1` instead of culling). Each sprite's instance `count = buffers.loaded[i] ? Math.ceil(c.count × budget) : 0` — 0 until that chunk's data has uploaded, otherwise the point-budget slider's fraction of the chunk's point count, written straight onto the sprites from a `store.subscribe` callback (registered in a `useEffect`, early-outs unless `budget` or `loaded` changed) so a chunk is visible in the frame it lands without a React render per chunk (draw call count stays fixed; only instance count changes with budget).

- **`userData('chunkBase')`**: worked. HUD shows `tris 4000001` at 2M (`2 × 2,000,000 + 1`) and `tris 40000001` at 20M (`2 × 20,000,000 + 1`) with the one shared `PointsNodeMaterial`, confirming the per-object `userData('chunkBase')` correctly offsets `instanceIndex` into the shared storage buffer per chunk (Task 5) — shipped with no per-chunk-material fallback needed.
- **Draw calls at 100 % budget**: 257 at both 2M and 20M (256 chunk sprites + 1 renderer output blit).

### Store (`state/store.ts`)

Hand-rolled `createStore`/`useSyncExternalStore` store (no zustand, spec A7) — a plain object plus a `Set` of subscriber callbacks. `PointCloudViewer` creates **one store per viewer instance** via `useMemo` and provides it through `StoreContext`, so multiple viewers can coexist on a page without sharing state; `useViewerStore()` / `useStore(selector)` read it from inside that provider.

### Theming (`theme/tokens.module.css`)

`--pcv-*` custom properties on the viewer's root element consume Lab's own tokens (`--bg`, `--text-primary`, `--accent`, …) when embedded, falling back to a standalone dark palette when those aren't defined; a `[data-theme="light"]` block on the same root overrides the light variant. The viewer never reads Lab's token names directly, only its own `--pcv-*` layer, keeping it copy-paste embeddable per spec.

### Keys

Keyboard shortcuts (`F` refit, `H` toggle HUD, `\` held = key list) are bound via `onKeyDown`/`onKeyUp` on the viewer's root `<div tabIndex={0}>` only — nothing attached to `window`/`document` — so they're focus-scoped and never hijack the host page. The key list (`ui/Overlays.tsx`, `KEYS` table) is local React state, cleared on `keyup` and root `blur`; the same file's `LoadingOverlay` is a centred card (name, bar, `% · pts · chunks`) mounted while `status !== 'ready'` and no error is set.

### GPU lifetime

`PointBuffers.dispose()` calls only `qposNode.dispose()`/`flagsNode.dispose()`, which each dispatch a `'dispose'` event — they do **not** free the underlying GPU buffers themselves. r3f 9.7's `unmountComponentAtNode` never calls `gl.dispose()` on a `WebGPURenderer`: it only calls `renderLists?.dispose`/`forceContextLoss?.()`, and neither exists on that renderer, so `<Canvas>` unmount does **not** dispose the renderer. In practice the GPU buffers (`N×8` + `ceil(N/4)×4` B) and the renderer itself live until the page unloads — a known limitation, to be addressed when the viewer supports remount/dataset switching. Matters for embedders that mount/unmount `PointCloudViewer` repeatedly: today that leaks a renderer and buffer set per mount.

### Memory (20M)

| | GPU | CPU |
|---|---|---|
| positions (`qpos`) | 160 MB (`N×8` B) | 160 MB (main-thread `Uint32Array`, spec A6) |
| flags | 20 MB (`ceil(N/4)×4` B) | 20 MB (main-thread `Uint32Array` mirror) |
| normals (Phase 4, at load) | 80 MB (`N×4` B, oct u16×2) | 80 MB (zero-filled `Uint32Array` backing the attribute) |
| ao (Phase 4, at load) | 20 MB (`ceil(N/4)×4` B) | 20 MB |
| hash (Phase 4, at first build) | 113.6 MB (`cellStart` 16.8 + `cellCursor` 16.8 + `blockSums` 0.07 + `sorted` 80) | same (attribute backing arrays) |
| `pick` (Phase 5) | 8 B (`atomic<u32>[2]`: depth bits, index) | 8 B |
| `polygon` (Phase 5) | 2 KB (`vec2<f32>[256]`) | 2 KB |
| `chunkTable` (Phase 5) | 2 KB (`vec2<u32>[256]`: offset, visible end) | 2 KB |
| undo ring (Phase 5) | — | ≤ 256 MB (30 commands; a whole-buffer edit saves N = 20 MB) |

Computed storage total after a 20M build ≈ 394 MB. No other persistent per-point CPU copy: the loader worker transfers each chunk's buffer out and keeps nothing (the CPU bench's subsample copy lives only for the run).

### Type deviations

- `userData('chunkBase', 'uint') as unknown as Node<'uint'>` in `pointMaterial.ts` (carried from Task 4) — `@types/three` declares `userData()`'s return as `UserDataNode` (`Node<unknown>`), and the TSL `Node<T>` alias intersects to `{}` for arithmetic ops when `T` is `unknown`, hiding `.add`. The runtime object is proxy-wrapped with the operator regardless of the declared type, so the cast is purely to satisfy `tsc`; no runtime behaviour change.

### Frame timing, streaming vs settled (Task 6)

- **HUD frame ms, streaming vs settled** (rAF-timestamped trace from navigation, 1.5 s window):
  - 2M: ~19 frames at 3–5 ms (pre-data / empty scene) → one 37.9 ms warm-up frame → **one 216.5 ms outlier frame** → one 21.3 ms tail frame → steady 3.1–5.3 ms for the remaining ~280 frames (240 Hz rAF cap). A separate 200 ms-interval `__pcvUploadMs`-adjacent poll over 4 s post-load held flat at 4.08–4.18 ms. Whole demo load (256 chunks, 2M pts) finishes in well under 200 ms on localhost, so "streaming" and "first upload" are effectively the same few frames.
  - 20M: ~10 frames at 4–5 ms (pre-data) → 33.3 ms, **187.4 ms outlier frame**, 96 ms, 12.5 ms → steady ~29–34 ms/frame thereafter. `budget` hit 100 % at t≈385 ms into the run; a 250 ms-interval poll for ~2 s after that stayed in the same 29–34 ms band (GPU render cost at 20M pts / 40M tris, not upload cost — no further spikes).
  - Conclusion: the first `needsUpdate` pays one single-frame cost (≈190–220 ms depending on scale, evidently upload + pipeline/bind-group creation); every subsequent per-chunk upload is folded into ordinary partial-range writes and produces no separate frame-time spike. This matches "partial upload", not a 16 MB/160 MB full-buffer re-upload per chunk (which would show ~256 repeated multi-ms+ spikes, not one).
  - Both sets load fast enough on localhost (dev server, no real network latency) that a distinct "mid-stream" HUD-ms plateau, separate from settled state, could not be resolved by 200 ms-interval polling alone — only the rAF per-frame trace isolated the single long frame.
- **Concern**: driving the 20M/160 MB load through repeated `page.evaluate` round trips (one per ~200 ms sample, ~60 calls) crashed the Playwright browser tab once (`Error: Target crashed`); switching to a single in-page polling/rAF loop that returns one aggregated result on completion avoided it. Worth keeping in mind for any fuller full-set instrumentation in later tasks.

### Browser verification (Task 8)

Same machine/session as above, `phase-2-viewer` branch. Colour-mode/colormap selects and range inputs driven via native-setter + `dispatchEvent` (React-controlled inputs ignore plain `.value =`).

**Screenshots** (`.playwright-mcp/`, gitignored):
- `p2-t8-class.png` — 2M, Classification mode: buildings amber/orange, streets grey, small vegetation patches green, ground foreground brownish-tan, a few magenta specks (another class).
- `p2-t8-intensity.png` — 2M, Intensity mode, Viridis: purple→teal→yellow by return strength; the ferris wheel (high-reflectivity metal) glows bright yellow-green against a mostly purple/teal scene.
- `p2-t8-turbo.png` — 2M, Height mode, Turbo colormap: blue at ground level rising to green at building tops.
- `p2-t8-grayscale.png` — 2M, Height mode, Grayscale colormap: dark-to-light by elevation, building tops brightest.
- `p2-t8-size6.png` — 2M, point size 6px, budget 100%: visibly larger, blobbier dots vs. the 2px baseline (ferris wheel reads as rounded blobs, not fine dots).
- `p2-t8-light.png` — `theme="light"` (temporary `App.tsx` edit, reverted after): white page background, light panel card, dark panel/HUD text.
- `p2-t8-dark.png` — theme reverted to default: dark background/card/light text restored, confirming a clean HMR revert (no reload, HUD state preserved throughout).
- `p2-t8-full-100.png` — full set (20M), budget 100%, size 2: denser point coverage than the 2M demo at the same view, renders correctly.
- Diagnostic (see bug below): `p2-t8-initial-check.png`, `p2-t8-resize-check.png`, `p2-t8-fresh-nav-1280.png`.

**HUD numbers** (`ms fps draws tris loaded budget`, all 2M unless noted):
| Config | HUD |
|---|---|
| Height/Viridis baseline (100%, size 2) | `4.19 ms 239 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Classification | `4.17 ms 240 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Intensity/Viridis | `4.17 ms 240 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Height/Turbo | `4.19 ms 239 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Height/Grayscale | `4.17 ms 240 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Budget 10% | `4.14 ms 241 fps draws 257 tris 400253 loaded 2,000,000/2,000,000 budget 10%` |
| Point size 6 (budget 100%) | `4.19 ms 239 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| `theme="light"` | `4.12 ms 243 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| Dark (reverted) | `4.17 ms 240 fps draws 257 tris 4000001 loaded 2,000,000/2,000,000 budget 100%` |
| **Full 20M, budget 100%, size 2** | `32.81 ms 30 fps draws 257 tris 40000001 loaded 20,000,000/20,000,000 budget 100%` |
| **Full 20M, budget 50%** | `17.57 ms 57 fps draws 257 tris 20000127 loaded 20,000,000/20,000,000 budget 50%` |

Budget-10% tris check (computed in-page from the manifest, one `browser_evaluate` call, one settle rAF): expected `2 × Σ ceil(count_i × 0.1) + 1 = 400,253`, actual HUD `tris = 400,253` — **exact match**. Budget-50% tris on the full set (`20,000,127`) is consistent with the same formula at 20M pts. Acceptance (≥~15 fps at 20M/DPR 1) met: 30 fps at 100%, 57 fps at 50%.

**Console status**: 0 errors, 2 benign warnings (`THREE.WebGPURenderer: PCFSoftShadowMap has been removed. Using PCFShadowMap instead.`, repeated) through every step-1/2/3 mode, colormap, budget, point-size and theme change, and through both full-set (20M) reads at 100% and 50% budget.

**Bug found — black canvas + continuous WebGPU depth-stencil `GPUValidationError` on a fresh page load.** A plain `page.goto('http://localhost:5173/')` (hard navigation, no prior resize) renders a **fully black canvas** while the HUD/store bookkeeping is otherwise correct throughout (`loaded 2,000,000/2,000,000`, `draws 257`, `tris 4000001`). The console fills with two `Uncaptured WebGPU GPUValidationError`s per frame, continuously, e.g.:
```
THREE.WebGPURenderer: Uncaptured WebGPU GPUValidationError: The depth stencil attachment [TextureView of Texture "depthBuffer"] size (width: 300, height: 150) does not match the size of the other attachments' base plane (width: 1200, height: 1279).
 - While validating depthStencilAttachment.
 - While encoding [CommandEncoder "renderContext_1"].BeginRenderPass([RenderPassDescriptor]).
 - While finishing [CommandEncoder "renderContext_1"].
THREE.WebGPURenderer: Uncaptured WebGPU GPUValidationError: [Invalid CommandBuffer from CommandEncoder "renderContext_1"] is invalid due to a previous error.
 - While calling [Queue].Submit(...)
```
300×150 is the browser's default intrinsic `<canvas>` size — the WebGPURenderer's depth-stencil texture is created at that size and never resized to match the colour attachment, which *does* track the real container size (1200×1279 in one repro, 1280×800 in another — reproduced at two different viewport sizes, so it isn't tied to a specific size). Screenshots: `p2-t8-initial-check.png` (black, first repro) → `p2-t8-resize-check.png` (same scene, now correct, immediately after an explicit `page.setViewportSize(...)`, i.e. a real DOM `resize` event) → `p2-t8-fresh-nav-1280.png` (reproduced again on a second fresh `page.goto` at 1280×800: black, 197 accumulated errors over ~53 s, full trace in `.playwright-mcp/console-2026-09-16T11-12-53-376Z.log`, 25,380 `[ERROR]` lines from that one navigation, until a follow-up resize fixed it). An explicit resize after load — even to the *same* size the page already has — consistently fixes it and errors stop immediately. Both full-set (20M) navigations later fired `browser_resize` right after `page.goto` and before waiting for load, and saw 0 console errors both times, consistent with "an explicit resize event is needed to reconcile the depth-stencil texture; the initial mount-time layout alone isn't enough." This reproduces for a real user loading the page cold without ever resizing their window — not a Playwright artifact. Root cause not investigated further and no code was changed, per task instructions; likely in `Scene.tsx`'s `Canvas`/`WebGPURenderer` `gl` factory (async `renderer.init()` racing the R3F `ResizeObserver`-driven initial `setSize`, or a depth-stencil render target not included in that resize path). **Not previously reported** — Tasks 5 and 6 both got clean renders/`0 errors` on their first navigations; this may be timing-sensitive (async adapter/`renderer.init()` race) or session-state-sensitive (this session's browser window/viewport differed from theirs) rather than fully deterministic.

**Secondary concern — one more Playwright tab crash.** The first attempt to wait for the 20M/160 MB load (a single `browser_evaluate` with an in-page `setTimeout` polling loop, per the Task 6 lesson) still crashed the tab (`Error: Target crashed`), despite that pattern being the one Task 6 found safe. Recovered by re-navigating; the second attempt used `browser_wait_for` with text-match (Playwright-native polling, not an in-page loop) plus an explicit `browser_resize` right after `page.goto`, and completed cleanly with 0 errors. So "single round trip" alone doesn't fully explain/prevent the crash risk from Task 6; this session had also accumulated ~370 MB across `.playwright-mcp/console-*.log` capture files from earlier tasks (one alone is 245 MB), which is a plausible contributing memory-pressure factor. Recommend `browser_wait_for` over an in-page `evaluate` loop for the 160 MB load in future tasks, and periodically clearing `.playwright-mcp/console-*.log` in long sessions.

### Renderer factory under StrictMode (Task 8b)

**Fixed** the black-canvas / per-frame `depthBuffer` 300×150 `GPUValidationError` bug reported above (commit after `c85f978`). Root cause, verified by instrumenting `Scene.tsx`: r3f 9.7 `createRoot().configure()` does `let state = store.getState()` *before* `await glConfig(defaultProps)`, and `<Canvas>` calls `configure()` from a dep-less layout effect, which StrictMode runs twice (mount → cleanup → mount) before the first async factory has resolved. Both runs see `state.gl == null`, so the factory ran 2× on the same canvas (counter: `[gl factory] 2`, `window.__renderers.length === 2`). The second run then finishes on its **stale zustand snapshot**: it creates a second `WebGPURenderer` (its `CanvasTarget` stays at the canvas default 300×150 because r3f's resize subscriber had already run `setSize` on the first one; the second becomes `state.gl` and does all the drawing → colour attachment at the real size, depth texture at 300×150 → the error every frame), a second `PerspectiveCamera(75, 0, …)` and a second `Scene`; its `state.setSize()` finds the store size already equal, so the subscriber never calls `updateCamera` on the new camera → `aspect = 0` → NaN projection matrix → black even with the renderer fixed. Any later resize event re-ran `updateCamera`/`setSize` on the live objects, which is why an explicit resize "fixed" it. Fix (`src/viewer/render/Scene.tsx`): make the renderer, camera, and scene idempotent — the renderer promise is cached per canvas in a `WeakMap<HTMLCanvasElement, Promise<WebGPURenderer>>` (factory still invoked 2× under StrictMode, one renderer), and `<Canvas>` gets stable `camera`/`scene` instances from `useMemo` instead of an options object, so the second run sets the same objects. Verified with Playwright: fresh nav at 1280×800, 1200×1279, 800×600 → 0 console errors (2 benign warnings), points visible, HUD `tris 4000001`; live resize 1280×800 → 900×700 follows with 0 errors. Not a three.js bug; alternatives ruled out: `setSize` before `init()` (`_initialized` guard) — both renderers were initialised; `antialias`/`requiredLimits` — unchanged. Separately: r3f's StrictMode fake-unmount schedules `dispose(state.scene)` plus root removal on the shared store roughly 500 ms later (dev-only; the renderer self-heals on the following real mount) — browser-verified, not a production concern.

## Post-processing (phase 3)

Machine/session as the phase 2 section above unless noted. Demo manifest 2,000,000 pts, full manifest 20,000,000 pts, both at point size 2 px, DPR 1, home pose (all shipped 20M numbers use this configuration — spec review cross-cutting note).

### Pipeline (`render/postprocessing.ts`)

One `THREE.RenderPipeline` per `<Canvas>` (`three/webgpu`; `PostProcessing` is the same class under a name deprecated since r183 — not used). `pass(scene, camera, { samples: 0 })` renders the Phase 2 scene to a `HalfFloatType` colour target (`PassNode` default) and a depth texture; the depth texture is the `DepthTexture` **default (24-bit, `UnsignedIntType` / `depth24plus`, no stencil)** — three 0.186 only promotes the pass depth to `FloatType` when `renderer.reversedDepthBuffer` is set, which this renderer does not set. `pipeline.outputNode` is the EDL shade node (`edlShadeNode`) when enabled, or `scenePass` (the colour texture node, unshaded) when off — off is a colour passthrough through the same pipeline, never a bypass of it. `pipeline.outputColorTransform` stays `true` (default), so ACES tone mapping (r3f's own default, unchanged from Phase 2) and sRGB colour-space conversion run exactly once, after EDL, on the HalfFloat intermediate — matching the Phase 2 canvas render's colour path. Toggling `setEnabled` swaps `outputNode` and sets `pipeline.needsUpdate = true` explicitly: three's `_update` only watches tone-mapping/colour-space changes, so an `outputNode` assignment alone does not mark the pipeline's quad material dirty and the swap would otherwise not take effect until some other state changed.

### r3f handover (`render/PostPass.tsx`)

`<PostPass>` is mounted as the last child of `<Canvas>`, after `<Hud>`. It builds the pipeline in a `useLayoutEffect` keyed on `[gl, scene, camera, store]` — not `useMemo`, because StrictMode double-invokes memo initialisers and would leak a pipeline — declared before `useFrame` (also a layout effect in r3f 9.7), so the handle exists before any frame can fire and no fallback render path is needed; cleanup nulls the ref then disposes. EDL params reach the handle through `useStore((s) => s.edl)` + an effect on `[edl]` (the `ChunkSprites` idiom), so per-chunk `loaded` store traffic never touches the uniforms. `useFrame(cb, 1)` (priority 1) increments `internal.priority`; r3f's own loop only calls `gl.render` when `internal.priority === 0`, so once `<PostPass>` is mounted the pipeline is the sole renderer and r3f's own `gl.render` never runs a second time per frame. `<Hud>` stays at priority 0 (unchanged since Phase 2) and its callback still runs before `<PostPass>`'s priority-1 callback each frame, so it reads and resets the previous frame's `renderer.info` before this frame's draws — same counter semantics as Phase 2, EDL adds nothing to that ordering. Browser-verified: `document.querySelectorAll('canvas').length === 1` and no repeated pipeline/renderer console warnings after the StrictMode mount→cleanup→mount cycle (Task 4 spike).

### Kernel (`render/edl.ts`)

Nine taps per fragment (centre + 8 ring directions at 45°): each is `depthTex.sample(uv).r` (raw depth texture sample, the `GTAONode` idiom) fed through `perspectiveDepthToViewZ(depth, near, far)` — this path is reversed-Z aware (the `Fn` branches on `renderer.reversedDepthBuffer` internally) and is used for **all nine** taps, including the centre; `PassNode.getViewZNode()` was not used because it is a centre-only tap and can't serve the ring. `near`/`far` are the pipeline's own `uniform()`s, written from `camera.near`/`camera.far` every frame in `PostHandle.render()` — the global TSL `cameraNear`/`cameraFar` nodes were not used because inside the pipeline's output quad they resolve to the quad's own orthographic camera, not the scene camera. Ring offset: `dir × radiusPx × dpr / screenSize` (`screenSize` from `three/tsl`, the drawing-buffer size in physical px), so `radiusPx` is a CSS-px control and the visual radius stays constant in CSS px regardless of `dpr`. Shade: `obs = mean_k(max(0, d0 − d_k))` in log2 view-distance, `shade = exp(−strength × obs × 300 / radiusPx)` (Boucheny's 300 constant, keeps `strength ≈ 1` sensible at `radiusPx ≈ 1.5`), output colour `= sceneColour × shade`. Background/silhouette rule: a centre at or beyond `far × 0.999` shades to 1 (untouched sky, no darkening at silhouette edges); a ring tap at or beyond that threshold is treated as `d_k = d0` (contributes 0 to `obs`) so a foreground point's silhouette against the sky doesn't pick up a halo from the background taps. `edlObscurance`/`edlShade` in the same file are the pure-TS reference the TSL node mirrors, covered by vitest; the node itself is browser-verified only (constructs renderer-bound nodes).

### Panel

`.group`/`.groupTitle` CSS module classes (`Panel.module.css`) wrap a "Lighting" group — checkbox EDL (default on), Radius slider (1–4 px, step 0.5, default 1.5), Strength slider (0–4, step 0.1, default 1); both sliders `disabled` (value still shown) while EDL is off. These classes are meant for Phase 4 ("Compute") and Phase 5 ("Editing") groups to reuse. Store: `ViewerState.edl: { enabled: boolean; radiusPx: number; strength: number }`, defaults `true / 1.5 / 1`; a nested patch replaces `edl` whole (`store.set({ edl: { ...store.get().edl, ...patch } })`), consistent with the store's shallow-merge contract.

### Measured

- **Demo (2M), HUD**: EDL on `4.14–4.17 ms 240–242 fps draws 257 tris 4000001`; EDL off `4.17 ms 240 fps draws 257 tris 4000001` — both vsync-capped at the 240 Hz / 4.17 ms floor, so the EDL cost is not resolvable at this scale.
- **20M, 100 % budget**: EDL on medians (3 runs of 3 samples each) `32.04 / 33.04 / 33.83` ms; EDL off medians `33.68 / 33.85 / 33.31` ms. Run-1 delta `32.04 − 33.68 = −1.64 ms`; median-of-medians delta `33.04 − 33.68 = −0.64 ms` — the "on" numbers are not reliably higher than "off" at all, i.e. the true EDL cost is **below the HUD frame-time EMA's own ±1 ms toggle-to-toggle noise floor**; report as "≤ 0.5 ms, not resolvable by HUD EMA" rather than a single precise delta. The ≤ 2.0 ms acceptance gate passes (trivially — the measured deltas are negative or near zero). `off` vs. the Phase 2 baseline row (`32.81 ms`, single run) sits within the same noise band (+0.5–1.0 ms). `draws 257 tris 40000001` in both states.
- **20M, 50 % budget** (smaller GPU/raster cost, so a real EDL delta is more likely to surface above noise): EDL off medians (2 runs) `17.07 / 17.11` ms; EDL on medians `17.49 / 17.22` ms; per-run deltas `+0.42` / `+0.11` ms — consistent with the full-screen 9-tap EDL quad costing roughly 0.1–0.4 ms at 1280×800, which is what disappears into the noise at the vertex/raster-bound 100 % row. `tris 20000127`.
- **`draws`/`tris` with the pipeline**: `draws 257` (256 chunk sprites + 1 pipeline output quad) — the **same count** as the Phase 2 canvas render, where the +1 was the `WebGPURenderer`'s own `_renderOutputLayers` blit. With `RenderPipeline` as the sole renderer (priority handover, above), that blit no longer runs — the pipeline's own output quad replaces it one-for-one rather than adding a second draw. Recorded as measured, not asserted; the design spec's "chunks + 2" expectation did not hold.
- **Off-equivalence** (Playwright screenshot diff, `phase2-off-1280x800.png` vs. an EDL-off capture, canvas region only — panel excluded as `260×520` px top-right plus the HUD text row `y < 30`, corrected from the spec's stale `260×360`, since the panel grew to ~245×495 px with the Lighting group): **`maxDiff 0`, `over1 0`, `over2 0`**, 858,690 sample pixels — bit-exact on the canvas, stronger than the ≤ 1/255-per-channel acceptance bar. (An unrestricted whole-image diff shows `maxDiff` up to 245 from the panel's extra rows and HUD ms-digit text differing between captures — not a rendering difference.)
- **Resize** (900×700, EDL on): no `GPUValidationError`; one extra `PCFSoftShadowMap has been removed` warning (r3f re-applies its default shadow config on every `renderer.setSize`, pre-existing, benign — see Deferred); relief correct, no stretching; HUD `4.21 ms`.
- **DPR 2** (`?dpr=2`, 1280×800 CSS): `canvas.width = 2560`, `canvas.height = 1600`. Demo HUD `4.17 ms 240 fps draws 257 tris 4000001` — same vsync floor as DPR 1 (2M is too light to expose a DPR-driven cost on the demo set). Relief radius equal in CSS px to DPR 1 (offset scales with `dpr`), finer point sampling. Console: 0 errors, `PCFSoftShadowMap` repeated ×3 (one per `setSize`/`setPixelRatio` call during navigation).
- **Console**, all steps above: 0 errors; only the two benign warnings (`THREE.Clock … deprecated`, `PCFSoftShadowMap has been removed`), the latter repeating once per resize/DPR change as noted.

## Compute (phase 4)

Machine/session as above (M4 Max, Chromium via Playwright MCP, DPR 1, size 2 px, home pose). GPU normals + ambient occlusion over **all** loaded points (independent of the render budget) in raw WGSL, three shading modes that consume them, and the same algorithms in TS as a benchmark and correctness oracle. Plan and rulings: `docs/superpowers/plans/2026-09-18-phase-4-compute.md`.

### Buffers (`render/PointBuffers.ts`, `compute/pipeline.ts`)

| buffer | owner | size | 2M | 20M |
|---|---|---|---|---|
| `normals` (oct u16×2 per point, `u32[N]`) | `createPointBuffers`, zero-filled at load | `N×4` B | 8 MB | 80 MB |
| `ao` (u8 per point, 4 per word, `u32[ceil(N/4)]`) | `createPointBuffers`, zero-filled at load | `ceil(N/4)×4` B | 2 MB | 20 MB |
| `cellStart` (`u32[T+1]`, atomic) | pipeline, first build | `(T+1)×4` B | 1.05 MB | 16.8 MB |
| `cellCursor` (`u32[T]`, atomic) | pipeline, first build | `T×4` B | 1.05 MB | 16.8 MB |
| `blockSums` (`u32[T/256]`) | pipeline, first build | `T/64` B | 4 KB | 65.5 KB |
| `sorted` (`u32[N]`, point indices grouped by cell) | pipeline, first build | `N×4` B | 8 MB | 80 MB |

`normals`/`ao` are allocated up front (plan ruling 2: +100 MB at 20M at load, never displayed before a build because the panel gates the lit modes on `compute.status === 'built'`). With `qpos` 160 + `flags` 20 the computed storage total after a 20M build is **≈ 394 MB** (160 + 20 + 80 + 20 + 16.8 + 16.8 + 0.07 + 80), well under the 256 MiB `maxBufferSize` per buffer (the largest single buffer is `qpos` at 160 MB). Hash buffers are never freed (no three API for it) and are reused by rebuilds. Compute never reads `flags`: hidden/deleted points stay in neighbourhoods (spec).

### Hash sizing (A4) and measured occupancy

`T = tableSizeFor(N) = nextPow2(max(1024, N/8))`: **262,144 at 2M, 4,194,304 at 20M** (`compute/params.ts`). Cell size = radius; cell key = `(x·73856093 ^ y·19349663 ^ z·83492791) & (T−1)` on the non-negative bounds-relative integer cell coordinates (kernels work in `q × dqScale`, no centroid — ruling 1, `dequantScale(manifest.bounds)` shared with the material). Collisions merge cells; the `d² ≤ r²` test keeps results exact, collisions only cost candidate work. Measured at 2M, radius 3 × spacing = 2.12 m: **232,825 occupied cells of 262,144 (occupancy 0.888)**, `cellStart[T] = 2,000,000` (Task 5's readback: 232,828 occupied, max 59 points per cell), and the GPU `cellStart` matched the CPU `buildGrid` oracle at **0 of 262,145 entries different** (Task 4 spike). Radius = `radiusMul × spacing`, `spacing = sqrt(areaXY / pointCount)` from the manifest's full count (0.707 m on the demo, 0.224 m on the full set); slider 2–10×, default **6×** (4.24 m demo / 1.34 m full, A11; § Normal quality).

### Pass order and dispatch shapes

`build(radius)` runs seven dispatches, timed as five rows: `zero` (`atomicStore(&cellStart[i], 0)` over `T+1`, ruling 6 — no 16.8 MB CPU upload; not resolved on its own, so its GPU time folds into the **count** row) → **count** (`atomicAdd` per point, `.compute(N, [64])`) → **scan** = `reduceBlocks` (`T/256` threads, serial 256-cell sum each) + `scanBlockSums` (one thread, serial exclusive scan over `T/256` sums: 1,024 at 2M, 16,384 at 20M) + `scanCells` (`T/256` threads, writes `cellStart` exclusive prefix, `cellCursor = cellStart`, `cellStart[T] = N`) → **scatter** (`atomicAdd` on `cellCursor`, writes `sorted`) → **normals** (thread per point) → **ao** (thread per word, `ceil(N/4)` threads, whole-word store). No `var<workgroup>`, no barriers: the block-serial scan is ~8M serial adds at T = 2²² and vitest-verifiable through the CPU mirror (`compute/cpu/hash.ts`); the three dispatches share one "scan" timing row. All point-parallel kernels use `instanceIndex` with an `i ≥ N` guard and `.compute(N, [64])`; three splits dispatches above 65,535 workgroups itself (A9) — verified by the 20M build writing every normal.

### Atomics, helpers, kernel rules

`cellStart`/`cellCursor` are `storage(attr, 'uint', n).toAtomic()` once each — the buffer struct becomes `value: array<atomic<u32>>`, so every `wgslFn` that touches them declares `ptr<storage, array<atomic<u32>>, read_write>` and the non-atomic kernels (`zero`, `reduce`, `scanCells`, `normals`, `ao`) go through `atomicLoad`/`atomicStore` (WGSL has no plain access to an atomic array). Compiled and ran first try; the two-node fallback was not needed. Shared WGSL (`pcvDecodePos`, `pcvCellKey`, `pcvOctEncode`, `pcvOctDecode`, `pcvSmallestEigenvector`) lives in one `wgsl()` code node passed as the `includes` of every `wgslFn` (`compute/wgsl/helpers.ts`). The Phase 0 kernel rules held throughout: every kernel returns `u32` and its call is `.toVar()`-ed (`call()` in `pipeline.ts` casts the untyped `wgslFn` result once); no `toReadOnly()`; `ao` and `flags` writes are thread-per-word; the `qpos` storage node is the same one the material reads.

### Normals and AO

`normalsKernel` (radius PCA, A11): 27-cell neighbourhood (`c0 ± 1`, skipping negative cells), every neighbour within `radius` — no candidate cap, no sort. Single-pass centred covariance of `d = p_j − p_i`: `n` starts at 1 (the point itself, `d = 0`), each neighbour adds to `n`, `s = Σd` and the six unique terms of `Σddᵀ`; `cov = Σddᵀ/n − mmᵀ` with `m = s/n`. Centring on `p_i` bounds every accumulated term by `radius`, so the f32 WGSL sums match the f64 CPU mirror (`compute/cpu/normals.ts`, same neighbour set; summation order differs — GPU `sorted` is atomic-scatter order, CPU grid is index order) without a centroid pre-pass. `n < 4` (fewer than 3 neighbours) → the +Z word; otherwise the 3×3 cyclic Jacobi (8 sweeps, Numerical Recipes rotation, identical in WGSL and TS), oriented to `nz ≥ 0`, oct-encoded as two **unsigned** u16 (`round((p·0.5+0.5)·65535)`, decoded `/65535` on both sides — controller ruling `bb959f2`). Degenerate word is `0x80008000` (WGSL `round(32767.5)` → 32768 half-to-even; in JS the constant must be written unsigned, `(32768 | 32768 << 16) >>> 0`, or it compares as a negative int32 and never matches a `Uint32Array` element). `aoKernel`: per point, `1 − above/total` over neighbours within the radius, "above" = `d·n > eps` with `eps = 0.02 × radius`; `total = 0` → 1; byte = `round(a·255)`. Readback sanity (2M, radius 3×): **+Z 117,789 / 2,000,000** — 117,790 under the previous `K = 16` kNN kernel; ground neighbourhoods never reached the cap.

### Normal quality (phase 4b)

At 20M density (spacing ≈ 0.224 m) the previous `K = 16` cap kept the PCA sample within ~0.5 m of any point whatever the radius, so the slider grew the search neighbourhood without growing the sample. Measure: the DEV `classStats()` hook (`ComputeRunner.tsx`) — per-class histogram of `|n.z|` (10 bins, oct-decoded from `readback()`) plus mean AO, keyed by the classification byte (`word1 >>> 24`). The **wall bin** `[0, 0.1)` on class 6 (building) is the fraction of facade points whose normal reads near-horizontal.

| config | class-6 wall bin, 2M | class-6 wall bin, 20M |
|---|---|---|
| `K = 16` kNN, 3× (2.12 m / 0.67 m) | 0.043 | not measured |
| radius PCA, 3× (2.12 m / 0.67 m) | 0.043 | 0.021 |
| radius PCA, 6× (4.24 m / 1.34 m, default) | 0.109 | 0.078 |

At 2M the 3× disc (~30 neighbours) was never cap-limited, so dropping `K` alone changes nothing there; the gain is the wider default — 3× → 6× raises the wall bin 2.5× at 2M and 3.7× at 20M. Ground (class 2) top bin (`|n.z| > 0.9`): 97.2 % → 97.5 % (radius PCA, 3×, 2M) → ≈99 % (6×, 20M). Acceptance (≥ 0.10 @2M, ≥ 0.07 @20M) is met without the neighbour-averaging smoothing pass the plan costed (a second `normals`-sized buffer, +80 MB at 20M; dropped — `docs/superpowers/plans/2026-09-18-phase-4b-normal-quality.md`, Task 2). Memory is unchanged from the Phase 4 table.

### Shading (`render/pointMaterial.ts`)

`shading` uniform (`flat 0 / lit 1 / litAo 2 / normals 3`, the last a debug view). The vertex stage oct-decodes `normalsNode[gi]`, transforms with `transformNormalToView` for the view-space term, and lights with wrap + fixed sun: `wrap = 0.30 + 0.45·|n_view · v|` (never fully black, camera-facing flip via `abs`) plus `sun = 0.25·max(n_world · L, 0)` for a fixed key light `L = normalize(-0.4, -0.3, 0.85)` (world +Z up; `normalObj` doubles as `n_world` — positions are centred, model matrix identity) — `lambert = wrap + sun` (0.30…1.0). AO byte from `aoNode[gi >> 2]` applies as `sqrt(ao)`, so occlusion shades rather than masking to black. The four modes are one **branchless** blend — `lit = step(0.5, shading)`, `useAo = step(1.5, shading)`, `debugNormals = step(2.5, shading)`, `light = mix(1, lambert · mix(1, sqrt(ao), useAo), lit)` — and `colorNode = mix(lut × vertexStage(light), vertexStage(|normalObj|), debugNormals)`, so the storage reads and the lighting evaluate once per vertex. The nested-`select` version rendered nothing in flat/litAo (three-0.186 finding recorded in the Phase 0 rules below). `lambert` is evaluated in flat mode too; pre-build all-zero normal words decode to `(0,0,−1)`, no NaN. Frame cost (same vertex-stage op count as the earlier headlight, no new branches): 2M `4.17 ms` in flat, lit and lit + AO (vsync floor); 20M `34–37 ms` before the build, `34.7–35.7 ms` after, `35 ms` in lit + AO — `draws 257 tris 40000001` unchanged.

### Timing semantics (`compute/timing.ts`)

`timedCompute` = `performance.now()` around `renderer.computeAsync` (**submit**: CPU encode + submit, does not await GPU completion) then `resolveTimestampsAsync(TimestampQuery.COMPUTE)` (**gpu**: timestamp-query delta, `null` when `hasFeature('timestamp-query')` is false; the renderer is built with `trackTimestamp: true`). Only the resolve result is used, never `renderer.info` (ruling 7 — the HUD resets it). Metal quantises the GPU value to multiples of ~0.0655 ms (0.066 / 0.131 / 0.197 at the hash passes). `elapsedMs` (panel "wall") spans the whole `build()` including the six awaited round-trips; at 2M the warm wall (129–138 ms) exceeds the GPU sum (88–93 ms) by ~40 ms, at 20M the gap is ~950 ms (see Deferred) — cite `gpu`, not wall, as kernel cost.

### CPU path (`compute/cpu/*`, `loader/loader.worker.ts`)

Same algorithms in TS over typed arrays (`decodePositions` + `buildGrid`, `computeNormals`, `computeAo`; vitest: `forEachNeighbour` against a brute-force distance scan, Jacobi on known matrices, oct round-trip < 0.5° (test bound; measured worst over the test's 2,000 PRNG vectors 0.0035° at [0.698, −0.427, −0.575], +Z 0.0012°), exclusive scan vs `reduce`, plane AO = 1, corner AO 0.68, a noisy-facade normal within 10° — 27 tests across `compute/params.test.ts`, `compute/cpu/*.test.ts`, `compute/verify.test.ts`). Runs in the existing loader worker (ruling 4: `cpuBench`/`cancelBench` on `LoaderIn`, `benchProgress`/`benchDone`/`benchCancelled` on `LoaderOut`), cooperative in 100k-point slices with a `setTimeout(0)` yield so a cancel lands between slices; results transferred back. Input = `benchWords(qpos.array, chunks, min(N, BENCH_CAP))`: the whole array when `N ≤ 2M` (then `slice()`d so the attribute's own buffer is never transferred), else the first `floor(n/chunks)` points of every chunk packed contiguously without padding — 256 × 7,812 = **1,999,872** points on the full set. The bench posts `store.bench`; DEV hook `window.__pcvBench = { state, run }` (separate from `window.__pcvCompute = { build, readback, tableSize, timings, state, cpuCellStart, classStats }`, owned by `<ComputeRunner>`'s effect). `classStats()` awaits `readback()` and builds the per-class `|n.z|` histogram + mean AO of § Normal quality. `readback()` throws before the first build (`getArrayBufferAsync` on an attribute no pipeline has bound). Cancel verified: Cancel ~3 s in → `status 'cancelled', progress 0.43`, re-run works.

### Verify (`compute/verify.ts`)

`compareResults(gpuNormals, gpuAo (packed words), cpuNormals, cpuAo, n)` → sign-insensitive angle per point (`acos(|a·b|)`), median/max, `+Z` count on the GPU side, AO MAE normalised to [0,1], non-finite count. Enabled only when `pointCount ≤ BENCH_CAP` (same point set on both sides); on the full set the panel shows "Verify needs the same points on both sides — demo set only." Result (2M, radius 3×): `n 2,000,000 · median 0.000° · max 81.23° · AO MAE 0.0001 · non-finite 0 · +Z 117,789`. GPU and CPU sum the identical neighbour set, so the only disagreement is f32 (WGSL) vs f64 (JS) Jacobi picking a different smallest eigenvector on near-isotropic neighbourhoods (tail under the kNN kernel, same order of magnitude: ≤ 0.1° 1,999,570 · (0.1, 1]° 217 · (1, 5]° 123 · (5, 20]° 76 · > 20° 14, fraction > 1° = 1.07e-4; max then 80.77°). AO: 52,676 of 2M bytes differ, 51,808 by exactly 1 LSB (WGSL `round()` is ties-to-even, `Math.round` is half-up), 868 by more (points whose normal differs). Verify reports MAE with no gate; the median is the acceptance number.

### Measured

**Pre-4b (`K = 16` kNN, radius 3 × spacing = 2.12 m demo / 0.67 m full)** — kept for the per-pass hash rows. GPU = timestamp query per pass; console 0 errors in every run (2 benign warnings on the demo, 3 on the full set — `PCFSoftShadowMap` fires once per StrictMode mount).

| pass | 2M gpu ms (Task 5 / Task 6 / this task) | 20M gpu ms (cold / warm) | CPU ms @2M (3 runs) | CPU ms, 20M subsample (1,999,872 pts) |
|---|---|---|---|---|
| count | 0.07 / — / 0.07 | 1.44 / 1.84 | — | — |
| scan | 0.13 / — / 0.20 | 1.64 / 1.70 | — | — |
| scatter | 0.20 / — / 0.13 | 5.51 / 5.51 | — | — |
| hash (sum) | 0.40 / 0.52 / 0.40 | 8.59 / 9.05 | 17.4 / 17.3 / 18.6 | 17.4 |
| normals (`K = 16`) | 55.31 / 55.64 / 55.25 | 814.42 / 818.15 | 5,751 / 6,247 / 5,781 | 7,167 |
| ao | 36.96 / 31.78 / 31.52 | 717.03 / 704.25 | 4,662 / 4,638 / 4,868 | 6,906 |
| total gpu | 92.67 / 87.94 / 87.17 | 1,540.04 / 1,531.45 | | |
| wall | 129 / — / 138 ms | 2,519 / 2,488 ms | ~11 s | 14.5 s |

**Shipped (radius PCA, 6 × spacing = 4.24 m demo / 1.34 m full):**

| pass | 2M gpu ms | 20M gpu ms | CPU ms @2M (3 runs) | CPU ms, 20M subsample (1,999,872 pts, 2 runs) |
|---|---|---|---|---|
| hash | (0.52) | (9.05) | 17 / 18 / 19 | 18 / 14 |
| normals (radius PCA) | 34–36 (36.37 single run) | 630 | 6,587 / 7,834 / 7,630 | 4,582 / 4,663 |
| ao | 46 (46.33 single run) | 685 | 6,363 / 6,329 / 6,099 | 4,220 / 4,029 |
| total gpu | 80–83 | 1,321 | | |
| wall | 121–130 ms | 2,536 ms | 13.0 / 14.2 / 13.8 s | 8.8 / 8.7 s |

- 2M target < 200 ms GPU: met — 87–93 ms (kNN, 3×) → 59 ms (radius PCA, 3×) → 80–83 ms (radius PCA, 6×): dropping the 16-slot register sort saves more than doubling the radius costs. First build after a reload includes pipeline compile (pre-4b: normals 56.75, ao 36.70, wall 208 ms; hash-only 181.8 ms cold → 20.1 ms warm).
- 20M at the same 3×: `normals` 818 → 743 ms, `ao` 704 → 667 ms without the register sort (likely spilled on Metal); at 6× `normals` 630 ms (still under the capped kernel), `ao` 685 ms (more candidates per point), total 1,321 ms, wall 2,536 ms. `T = 4,194,304`; `builtRadius` 0.6708 m (3×) / 1.3416 m (6×).
- Class-6 `|n.z|` wall bin (the normal-quality evidence, § Normal quality): 0.021 (20M, 3×) → 0.078 (20M, 6×); class-2 top bin ≈ 0.99 at the 6× default.
- CPU at 6× vs kNN at 3×: 2M normals 5.8 → 6.6–7.8 s, ao 4.7 → 6.1–6.4 s (≈4× the neighbours per point, no cap). The 20M subsample is *faster* than the demo (4.6 / 4.1 s): a 1-in-10 chunk prefix has a tenth of the full density at the same 1.34 m radius, so far fewer neighbours per point — the same reason Verify can't run on it.
- Screenshots (`.playwright-mcp/`): pre-4b `shading-flat.png`, `shading-lit.png`, `shading-litao.png`, `shading-litao-close.png` (2M, EDL off close-up: facets from compute shading alone, no 16×16 chunk-grid seams), `shading-litao-20m.png` (20M, Lit + AO, EDL on, HUD `36.07 ms 28 fps draws 257 tris 40000001`, panel table visible); 4b `4b-normals-before.png` / `4b-litao-before.png` (`K = 16` baseline), `4b-normals-pca.png` / `4b-litao-pca.png` (radius PCA, 3×), `4b-litao-x6.png` / `4b-lit-x6.png` / `4b-litao-x6-close.png` (radius PCA, 6× default, wrap + sun shading).
- Panel: Compute group (radius slider `2–10×` step 0.5 with the metre readout, default 6×, Build button → "Building…"/"Built", timing table submit/gpu per pass + total + wall, Shading select flat / lit / lit + AO / normals (debug), the last three disabled until built; Build re-enables when the radius moves — ruling 5); Benchmark group (Run CPU / Cancel with progress %, GPU-vs-CPU ms table labelled `(all)`/`(cap)` when the bench ran on a subsample, Verify button gated on built + `N ≤ 2M`, summary line).

## Editing (phase 5)

Machine/session as above (M4 Max, Chromium via Playwright MCP, DPR 1, size 2 px, 1277×860 canvas, home pose). Click pick and lasso select as WGSL compute over the rendered prefix of every chunk, CPU ops on a byte mirror of the flags buffer, RANSAC/PCA plane split, an undo ring of byte slices, and a worker-side export to the v1 zip layout. Plan and rulings: `docs/superpowers/plans/2026-09-19-phase-5-editing.md` § "Rulings on the spec-review items" (rulings 1–20 cited by number below).

### Flags mirror and upload path (`render/PointBuffers.ts`, `edit/flags.ts`)

`flagBytes = new Uint8Array(flags.array.buffer)` — byte *i* is point *i*, the same little-endian byte the vertex stage unpacks (`byteOf(flagsNode)` = `word >> ((i & 3) × 8) & 0xff`; `flags.test.ts` checks `wordOf` against that packing). Bits: `HIDDEN 1 · SELECTED 2 · DELETED 4 · SPLIT_A 8 · SPLIT_B 16`. `uploadFlagsRange(minIdx, maxIdx)` = `flags.addUpdateRange(minIdx >> 2, (maxIdx >> 2) − (minIdx >> 2) + 1)` + `needsUpdate` (ruling 1) — one word-aligned range per edit; three coalesces the ranges before the next frame's upload. Two directions of sync: CPU ops mutate the mirror and upload; the lasso kernel mutates the GPU buffer and the pipeline copies the readback into the mirror with `flags.array.set(new Uint32Array(buf))` and **no** `needsUpdate` (ruling 9 — the GPU already holds it). If the readback rejects after the kernel ran, `EditRunner` re-uploads the whole mirror so the mirror stays the source of truth.

### Kernels (`compute/wgsl/select.ts`, `edit/selectPipeline.ts`)

Shared prologue `selectHelpers`: `pcvProject` (world = `q × dqScale + (bounds.min − centroid)`, the material's frame; clip = `viewProj × world`; screen px from the CSS viewport, WebGPU `[0, 1]` depth), `pcvVisibleEnd` (binary search of `chunkTable[c] = (offset, offset + ceil(count × budget))`, 256 entries rewritten before every dispatch — ruling 11: only *rendered* points are pickable/selectable, so the budget slider can't edit invisible points), `pcvInPoly` (even-odd crossing test, same rule as `edit/project.ts`). All kernels take `viewProj`/`view` as `mat4x4<f32>` parameters (the spike's vec4-column fallback wasn't needed), forward `ptr<storage, array<…>, read_write>` into the helpers (not inlined), and use raw `atomicMin`/`atomicStore` (no `atomicFunc` wrapper) — all three compiled first try on Metal.

- **Pick** = three dispatches + one 8-byte readback: `resetPick` (`atomicStore` 0xffffffff into `pick[0..1]`, `.compute(2, [1])`, ruling 15 — no CPU upload path to trust) → `pickDepth` (thread per point: skip `i ≥ visibleEnd`, hidden/deleted, behind the camera or outside `[0, 1]` depth; radius `r = max(3, clamp(pointSize × refDist / −viewZ, 1, 8))` px, the material's attenuated size (ruling 3, `refDist = homePose(manifest, fov).dist`); `atomicMin(&pick[0], bitcast<u32>(depth))` — depth is a non-negative f32 so its bits order like the value) → `pickIndex` (same expression, bit-identical depth; `atomicMin(&pick[1], i)` where `bitcast<u32>(depth) == pick[0]`, so ties resolve to the lowest index). `getArrayBufferAsync(pickAttr)` → `index` (`0xffffffff` = miss). GPU vs the CPU reference (`edit/project.ts`, identical matrices via the DEV `api.viewParams`) over 20 cursors at 2M: **18/20 exact-index agreement, 20/20** under "CPU depth of the GPU pick ≤ CPU best + 1e-6 and within r + 0.5 px" — the two exact misses are f32 depth ties (Δ 1.1e-9 / 2.8e-8 in f64, below the f32 ULP near 1.0 ≈ 6e-8), no systematic offset. At budget 0.5 the centre pick lands inside its chunk's rendered prefix.
- **Lasso** = `lassoSelect`, thread per **word** (`ceil(N/4)` threads, ruling: flags writes are thread-per-word): read the word once, test its four points (visible-prefix, not hidden/deleted, in front, inside the polygon's bbox, then `pcvInPoly` against `poly: vec2<f32>[256]` — `MAX_LASSO_VERTS`, the overlay simplifies at 2 px and decimates longer strokes to ≤ 256 vertices by keeping every ⌈n/256⌉-th one), write it back once. Modes: replace clears `SELECTED | SPLIT_A | SPLIT_B` on every byte then sets inside; add ORs; subtract clears inside, and any byte that loses `SELECTED` loses its split tags too. Timed with `timedCompute` (ruling 13) then a full-buffer readback into the mirror.

### Tint (`render/pointMaterial.ts`)

Three weights from the flag byte, `float(fbyte & bit) / bit` (0 or 1, no `select`), packed in one `vertexStage(vec3(sel, a, b))`; `colorNode = mix(mix(mix(base, cSel, sel × 0.7), cA, a), cB, b)` — branchless, so the three storage reads and the blend evaluate once per vertex (Phase 0 rule). `cSel` defaults to `#bf1656` and is overwritten from `--pcv-accent` computed on the viewer root (`PointCloudViewer` effect → `accent` prop → `ChunkSprites` → `handle.setHighlight(accent)`; each viewer reads its own root), so the light theme's accent reaches the shader without a prop; `cA = #2ec4b6`, `cB = #ff9f1c`. Hidden/deleted still collapse the quad (`sizeNode = 0`) and are skipped by every kernel.

### Editor, ops, undo (`edit/editor.ts`, `edit/ops.ts`, `edit/undo.ts`)

`createEditor(buffers, manifest, store)` wraps every CPU op in `run(pushRange, op)`: busy guard → `undo.push(min, max)` (**push before mutate**: the slice is copied from the live mirror) → `op()` returns the touched range or `null` → `dropLast()` on `null` (a no-op edit leaves no undo entry) → `uploadFlagsRange` → `refresh()` (`scanFlags`: counts + selection span in one pass, depths → `store.edit`). Whole-buffer ops (`isolate`, `hide`, `del`, `unhideAll`, `tagSplit`) push `(0, N−1)`; `pick` and `clearSelection` push `selRange ∪ {idx}` where `selRange` is the `[min, max]` index span of the current selection tracked after every edit (ruling 19), so a pick-replace uploads and saves only that span. Op semantics: the *subject* of isolate/hide/delete is `SELECTED` ∧ (`splitSide === 'all'` ∨ the side bit); `isolate` hides every non-subject, non-deleted point (selection kept); `hide`/`del` clear the selection bits on the subject and set `HIDDEN`/`DELETED`. GPU selects go through `beginGpuEdit()` (push `(0, N−1)`, `busy = true`) / `endGpuEdit()` (`busy = false`, refresh) — `busy` serialises everything (ruling 17): ops, undo/redo, new picks/lassos and export are ignored while a GPU select or an export is in flight. Undo ring: dense byte slices, `MAX_COMMANDS 30`, `MAX_BYTES 256 MB`, evicting the oldest on either cap; undo/redo swap the slice with the live bytes and upload the range, so a command costs the same on either stack. A whole-buffer edit costs N bytes: ≈13 such edits at 20M; at 2M the 30-command cap binds first.

### Plane split (`edit/plane.ts`)

`split()` collects the selected points' bounds-relative positions (`selectedPositions`, a full-N scan — see Deferred), draws a `samplePoints` stride sample of ≤ 50,000, and fits RANSAC (200 three-point hypotheses, seeded `mulberry32`, inlier threshold = 2 × `spacingOf(bounds, pointCount)` — 1.41 m demo, 0.45 m full) refined by PCA on the inliers (`smallestEigenvector` from `compute/cpu/normals.ts`, ruling 14 — no second Jacobi; the RANSAC normal's orientation is kept so A/B are stable). `tagSplit` then tags every selected point `SPLIT_A` (signed distance ≥ 0) or `SPLIT_B` over the full buffer; `edit.split = { fitted, inlierRatio }`, the toolbar's side select scopes the next op. Fewer than 3 points or a degenerate fit sets `edit.message`. Test data note: the planned 8-point fixture was collinear in xy (y = 0.375 x), so PCA's smallest axis was in-plane; the shipped test uses a y stride of 13,000.

### Export (`edit/export.ts`, `loader/loader.worker.ts`, `loader/useLoader.ts`)

`api.exportZip()` (busy-gated) slices `qpos.array` and `flagBytes` and transfers both to the loader worker (`export` on `LoaderIn`, ruling 8; 160 + 20 MB at 20M). The worker runs `compactPoints` (two-pass, preallocated: drops `DELETED` only, keeps hidden, preserves order, tracks the quantized min/max), `exportManifest` (version 1, `name (export)`, `source#export`, same bounds/crs/license/classMap, **one chunk** with dequantized bounds) and `buildZip` (`fflate.zipSync`, `points.bin` stored at level 0 + `manifest.json`), transfers the zip back (`exportDone`) and releases its inputs (A6). Main thread: Blob → `<a download="export.zip">`, `busy = false`, `message = exported N points`; `exportError`, a `postMessage` throw and a worker teardown mid-export all clear `busy`. Re-open is a fresh page load (ruling 7): unzip into `public/data/<name>/`, `?data=<name>` (`[a-z0-9-]+`). Verified at 2M: 962,730 deleted → `count 1,037,270`, `points.bin` = 1,037,270 × 8 B, 8,299,088-byte zip, 33.4 ms busy span; re-opened as `?data=export` at 1,037,270/1,037,270, 1/1 chunks, the deleted rectangle visibly cut out. At 20M (2,585,049 deleted): `count 17,414,951`, `points.bin` 139,319,608 B = 17,414,951 × 8, zip **139,320,509 B**, **398 ms** busy span; `unzip -l` + manifest `pointCount 17414951`, 1 chunk (not re-opened at 20M).

### UI (`ui/Toolbar.tsx`, `ui/LassoOverlay.tsx`, `ui/keys.ts`)

`keyAction()` is a pure map (ruling 2: `L Esc I X Delete/Backspace U C S`, `⌘/Ctrl+Z`, `⇧⌘Z`; `F`/`H` unchanged, `H` stays HUD) on the root's `onKeyDown` (ruling 10, no `activeElement` check) — it bails on modified letters so browser shortcuts pass through and returns early for `SELECT`/`INPUT` targets so the panel's controls don't fire ops. Click pick = `pointerdown` → `pointerup` on the root with < 4 px travel, primary button only; plain = replace (a miss clears the selection), `⇧` = add, `⌥` = subtract (ruling 16, same modes as the lasso). `LassoOverlay` is an SVG sibling of `<Scene>` (`inset: 0`, and explicit `width/height: 100 %` — an `<svg>` is a replaced element and sat at 300×150 without it), mounted only in lasso mode with pointer capture; `EditRunner` sets `controls.enabled = tool === 'orbit'` (ruling 6). `<Canvas>` is pinned `position: absolute; inset: 0` so the r3f wrapper and the overlay share the root box. Toolbar buttons `preventDefault` on mousedown so the root keeps focus; the split-side `<select>` takes focus normally. Two React bugs found in the browser: reading `e.currentTarget` inside a `setState` updater (nulled by then → unmounted the viewer), and the SVG sizing above.

### Measured

Budget 100 %, 1277×860, home pose, console 0 errors throughout (the three benign three.js warnings only). 2M numbers from the implementation tasks; 20M from one session on the full set after `20,000,000/20,000,000` (`?data=full`).

| op | 2M | 20M |
|---|---|---|
| pick, wall (`edit.pickMs`, 5 cursors) | 2.12 mean (7.2 first incl. compile; 3.6–4.9 via the click path) | 36.7 / 90.4 / 102.9 / 103.0 / 145.9 (mean 95.8; Task 6 session 15–144) |
| lasso replace, 30–70 % square: gpu / readback / selected | 0.131 / 12.3 ms / 1,725,277 (`cpuLasso` exact match) | 1.11 / 139.8 ms / 16,772,354 (Task 6 session: 1.11–1.18 / 137–175 / 17,253,695) |
| lasso add, 50–90 % square | 0.066 / 6.8 ms / 1,840,478 | 7.21 (first after a frame; 0.98 on repeat) / 166.8 ms / 18,150,830 |
| lasso subtract, 30–70 % square | 0.131 / 6.4 ms / 115,201 (= add − replace) | 1.11 / 173.2 ms / 1,378,476 (= 18,150,830 − 16,772,354) |
| lasso wall (`api.lasso` → `busy` false: undo copy + kernel + readback + `scanFlags`) | — | 311–378 ms |
| `hide()` on the selection (CPU pass + 20 MB upload + recount) | — | 146.9 ms (16,772,354 hidden) |
| `del()` on a 2,585,049-point selection | — | 123.8 ms |
| `undo()` / `redo()` of a whole-buffer op | — | 51.1 / 41.5 / 51.7 / 50.6 ms |
| `unhideAll()` with nothing hidden (full pass, `dropLast`) | — | 100.9 ms |
| `split()` on the selection | `fitted true, inlierRatio 0.147` (1,676,881 pts) | 489 ms (16,772,354 pts → A 5,916,458 / B 10,855,896, `inlierRatio 0.053`) |
| export (busy span) / zip | 1,037,270 pts, 33.4 ms, 8,299,088 B | 17,414,951 pts, 398 ms, 139,320,509 B |
| frame ms at home pose: no edits / 16.8M selected (tint) / 16.8M split-tagged / 16.8M hidden / 2.6M deleted | 4.17 (vsync floor) in every state | 33.30 / 33.19 / 33.20 / 18.96 / 30.12 |

- The lasso kernel is 1.0–1.2 ms at 20M (thread per word, 5M threads) — the 20 MB readback (135–173 ms) and the CPU bookkeeping (undo copy 20 MB, `scanFlags` one 20M-byte pass) are the cost; see Deferred for why the partial-readback fallback was not taken.
- `pickMs` is wall time including queued render frames; the two 20M-thread passes plus reset are not timestamp-queried. At 2M (4 ms frames) it reads 2–5 ms. The deslop pass batched reset + depth + index into one `computeAsync([...])` submit (one encoder, same-queue order carries the atomic dependency): 2.6–2.9 ms at 2M after the change; the 20M rows above are from the three-submit version.
- The tint adds no measurable frame cost (33.2–33.3 ms with 0 or 16.8M points tinted); hiding 16.8M points drops the frame to 19 ms because collapsed quads rasterise nothing.
- Undo of a `split` leaves `edit.split` stale (Deferred).
- Screenshots (`.playwright-mcp/`, 2M): `task5-1-selected-tint.png` / `task5-2-hidden.png` / `task5-3-undo.png` (tint, hide, undo round-trip), `task-6-lasso-2m.png`, `p5-pick.png`, `p5-lasso-drawing.png` (SVG polygon, accent stroke, dashed), `p5-lasso.png`, `p5-split.png` (teal/orange sides), `p5-isolate.png`, `p5-export.png` (re-opened export with the deleted rectangle cut out).

## Phase 0 spike findings (three 0.186.0)

Machine: Apple M4 Max, macOS 25.6.0, Chromium 153.0.8010.48 (Playwright), WebGPU adapter `apple` / `metal-3`, DPR 1, 240 Hz rAF cap (4.17 ms empty frame). Run: `?n=2000000&size=3|8`.

- Point draw mechanism: **Sprite quads** (`THREE.Sprite` + `PointsNodeMaterial`, `sizeNode` in px, `sizeAttenuation=false`); verts/point = 4 (2 tris); HUD `pts 0  tris 4000001` at 2M (the +1 is the renderer's output-quad pass, see below).
  - Primary path (`THREE.Points` + `PointsNodeMaterial.sizeNode`) rendered but check 5.3 **failed**: `?size=8` identical to `?size=3`, always 1 px. No console error; three's own docs in `PointsNodeMaterial.js` state WebGPU point-list only supports 1 px and `sizeNode` "has no effect when the material is used with Points and a WebGPU backend". HUD on that path: `draws 2  pts 2000000  tris 1`.
  - Brief's fallback used `SpriteNodeMaterial.scaleNode`; per `SpriteNodeMaterial.setupPositionView` that scale is world units × `-viewZ` when `sizeAttenuation=false` (not px). `PointsNodeMaterial` on a `Sprite` takes `setupVertexSprite`, which adds `sizeNode * DPR / (viewport/2) * clip.w` → true pixel size. Used that instead.
- Positions: `StorageInstancedBufferAttribute(Uint32Array, 2)` → `uint32x2` instanced attribute; bit-unpack in vertex (`x = w.x & 0xffff`, `y = w.x >> 16`, `z = w.y & 0xffff`, `cls = (w.y >> 24) & 0xff`). No pipeline/shader errors mentioning `qpos`, `uvec2` or `vertex buffer`.
  `uint16x3` is not a WebGPU vertex format; `uint16x4` would block compute reads (no u16 in WGSL). Words layout = disk bytes.
- Point index in vertex stage: `instanceIndex` (`storage(attr,'uvec2',n).toAttribute()` reads per-instance).
- Bounds: set `geometry.boundingBox/boundingSphere` manually. Points path: culling verified with stock `Points` (`pts 2000000 → 0`). Sprite path: `Sprite.intersectsFrustum` calls `frustum.intersectsSprite` (unit sphere at object origin, ignores geometry bounds); overriding it with `frustum.intersectsObject(sprite)` makes the manual sphere effective — verified `tris 4000001 → 1` with the cloud off-screen, back to `4000001` on return.
- `draws` never reaches 0: `WebGPURenderer` renders to an internal target and blits with a fullscreen quad (`_renderOutputLayers`), which counts as `draws 1  tris 1`. Off-screen HUD = `draws 1  pts 0  tris 1`.
- `renderer.info` counters read 0 from r3f's `useFrame` unless `info.autoReset=false` (set once in `SpikeApp`'s renderer factory) and the app resets after reading (`Hud`): three's internal rAF (`Animation.js`) calls `info.reset()` every tick and races r3f's loop.
- `info.render.timestamp` stays 0 unless `renderer.resolveTimestampsAsync('render')` is awaited; with that it reported 11–17 ms per resolve at 2M/size 3, but resolves span several frames so it is not a per-frame number. Wall clock is the reliable metric for now.
- 2M @ size 3: 4.9–5.7 ms / ~180–200 fps (rAF wall clock, GPU bound above the 4.17 ms vsync). 2M @ size 8: 6.6–7.3 ms / ~140–150 fps. 1 px `Points` path: 4.17 ms / 240 fps (vsync capped).
- Console: 0 errors. Warnings (benign): `THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.` (drei) and `THREE.WebGPURenderer: PCFSoftShadowMap has been removed. Using PCFShadowMap instead.` (r3f default shadow type).
- Type deviations vs brief: `Points` typings lack `count` (runtime uses `object.count` for instance count; `Sprite` has it typed). `extend(THREE as any)` and `__spike` casts as briefed. `window.__spikeCamera/__spikeControls/__spikeGl` exposed from `SpikeApp` for headless checks.

### Compute: raw WGSL (`wgslFn`) writes flags, vertex reads them (Task 4)

Run: `?n=2000000&size=3`. Console: 0 errors (same two benign warnings as above).

- **`wgslFn` storage pointer params work.** `fn classifyEast(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>, word: u32, count: u32)` compiles and runs. `WGSLNodeFunction.js` parses any `ptr<…>` param as type `pointer` (`renderers/webgpu/nodes/WGSLNodeFunction.js`, `resolvedType.startsWith('ptr')`); `FunctionCallNode.generate` emits `&` + the node's property name (`nodes/code/FunctionCallNode.js:107-119`), which for storage buffers is `NodeBuffer_N.value` (`WGSLNodeBuilder.getPropertyName`, storage buffers are wrapped in `struct NodeBuffer_NStruct { value: array<T> }`). Generated call: `nodeVar0 = classifyEast( &NodeBuffer_992.value, &NodeBuffer_993.value, instanceIndex, 2000000u );`. Params are passed as a **named object** (`FunctionCallNode` accepts object or positional array; object matched by param name).
- **Void `wgslFn` calls are silently dropped in three 0.186.** First attempt (`-> void`, call as a bare statement, then with `.toStack()`) compiled to an empty kernel body (`// code … if ( instanceIndex >= … ) { return; }` and nothing else); the flags buffer read back all zeros and no red points. Cause: `FunctionCallNode.generate` returns the call snippet but never emits its own statement line (no `addLineFlowCode`, unlike `AssignNode`/`VarNode`/`LoopNode`/`ExpressionNode`), and `StackNode.build` ignores the return value of `node.build(builder, 'void')`. Fix: kernel returns `u32` and the call is consumed with `.toVar()` (`VarNode` always emits `nodeVar = …`). Rule for Task 6: **every `wgslFn` kernel entry returns a value and is `.toVar()`-ed**, or the store is done in TSL (`flags.element(i).assign(wgslFn(...))`). Not the brief's Step 2 fallback — pure-TSL kernels not needed.
- `toReadOnly()` **must not** be used on a storage node shared between compute and render: `setAccess` mutates the node, and `WGSLNodeBuilder.getNodeAccess` (`renderers/webgpu/nodes/WGSLNodeBuilder.js:1254`) already forces `read` bindings for non-compute stages. Same `storage()` node is bound `var<storage, read_write>` in compute and `read` in vertex with no extra call.
- **Nested `select()` in the vertex stage can hoist a shared node's first read into a branch (Phase 4, Task 5).** `select(shading.equal(0), 1, select(shading.equal(1), lambert, lambert.mul(ao)))` compiled to `if/else`, and the node builder emitted the first evaluation of the cached `modelViewMatrix` / `v_positionView` variables inside the `shading == 1` branch (where `positionView` was first referenced); the clip-space line after the branch read `v_positionView` unassigned on the other two paths, so every quad landed at one off-screen clip position and nothing rendered. Verified via `renderer.debug.getShaderAsync` WGSL dump. Rule: **mode blends in the vertex stage are branchless (`step`/`mix`); never let the first use of `positionView`/`modelViewMatrix` (or any shared cached node) sit inside a `select` branch.** `select` over purely local nodes (the oct-fold branches) is fine.
- **Index path:** `instanceIndex` in the vertex stage is the point index (Sprite instancing), `instanceIndex` in compute is `globalId.x` = word index. `flags[idx >> 2] >> ((idx & 3) * 8) & 0xff` gives the point's byte. Verified: east half (x > 500, screen lower-left from the default camera) red, west keeps class colours; GPU readback of the flags buffer counts 998,869 east points = CPU count over `qposAttr.array`. `vertexIndex` not needed.
- **Thread-per-word rule:** flag bytes are packed 4 per u32; the kernel dispatches `ceil(n/4)` threads and each stores one whole word (no atomics, no partial-byte writes). Any later pass writing flags (lasso, select, delete) must also be thread-per-word, or use `atomicOr`/`atomicAnd` on a `storage(...).toAtomic()` node if it needs per-point writes.
- **Timing (2M points, 500k words):** `submit` = CPU encode+submit time of `renderer.computeAsync` (it is `await init(); this.compute(...)`, `Renderer.js:2992-2998`, and does **not** await GPU completion — not a wall-clock kernel time). HUD number 1.0–1.6 ms is the first effect-run dispatch; `<StrictMode>` double-mounts so it is actually the second dispatch (pipeline already cached), the gap is not attributable to pipeline compile without a non-StrictMode measurement. Repeat dispatches from the console: 0.0–0.1 ms; GPU via `resolveTimestampsAsync('compute')` 0.066–0.197 ms (Metal timestamp granularity, values quantise to 0.066/0.131/0.197). `timestamp-query` **available** (`hasFeature('timestamp-query') === true`); `resolveTimestampsAsync` returns the duration and also writes `info.compute.timestamp`. `THREE.TimestampQuery.COMPUTE` exports from `three/webgpu` (`constants.js`, `{ COMPUTE: 'compute', RENDER: 'render' }`). Requires `trackTimestamp: true` at renderer construction.
- `renderer.getArrayBufferAsync(flagsAttr)` works for readback/verification; it throws (`Cannot read properties of undefined (reading 'size')`) if the attribute was never bound by any pipeline yet.
- `StrictMode` double-invokes `useMemo`; debug handles (`window.__spikePoints`) must be set from the effect on the committed object, not inside `useMemo`.
- Type deviations: `StorageBufferNode` is generic in `@types/three` (`StorageBufferNode<'uvec2'>`); a `wgslFn` call is typed as untyped `Node` (no `.toVar`), cast to `Node<'uint'>`.

### Scale (synthetic, M4 Max, Chromium 153.0.8010.48)

Run: `?n=<N>&size=3`, headless Chromium via Playwright MCP, default camera then ~2 s programmatic orbit (camera position rotated around `OrbitControls.target` in 20 steps, `controls.update()` each step), HUD read after a 3–5 s settle. `synthetic gen ms` = `console.time/timeEnd('synthetic')` around `makeSyntheticCloud` in `SpikePoints.tsx`; two values because `<StrictMode>` double-invokes `useMemo`.

| N | frame ms (default → post-orbit) | fps (default → post-orbit) | tris/frame | flags compute submit / gpu ms | synthetic gen ms (×2, StrictMode) | GPU mem MiB (computed buffers) | GPU mem MiB (proxy: GPU-process RSS delta) |
|---|---|---|---|---|---|---|---|
| 2M | 4.82 → 6.37 | 208 → 157 | 4,000,001 | 1.50 / 0.066 | 134.0, 136.4 | 17.2 (pos 16M + flags 2M) | n/a (not isolated; see note) |
| 10M | 25.10 → 24.68 | 40 → 41 | 20,000,001 | 0.90 / 0.262 | 655.1, 736.3 | 85.8 (pos 80M + flags 10M) | baseline before 20M load |
| 20M | 64.94 → 65.03 | 15 → 15 | 40,000,001 | 2.50 / 0.000 (default limits, compute failed) → **1.10 / 0.524 (after `requiredLimits` fix, adapter-clamped, see below)** | 1354.9, 1330.3 | 171.7 (pos 160M + flags 20M) | +77.4 MiB (GPU-process RSS: 225.5 MiB → 302.9 MiB, before→after 20M load) |

Notes:
- **GPU mem MiB (computed)** = `positions N×8 B + flags ceil(N/4)×4 B` (≈ `N×9` bytes), geometry/uniforms negligible, per brief. Not measured VRAM.
- **GPU mem MiB (proxy)** = `ps -eo rss,command` RSS (already KiB) of the Chromium `--type=gpu-process` helper for the session's browser, before vs. after navigating to `?n=20000000` (10M was already loaded as the "before" state). Apple Silicon is unified memory, so process RSS is a loose upper-bound proxy, not a VRAM reading; Chrome's task manager GPU-memory column is unavailable headlessly, per brief. Renderer-process RSS for the tab itself stayed flat (~484–489 MiB) across the 10M→20M transition, consistent with the flags compute buffer failing to allocate rather than the position buffer growing further.
- **Adapter-limit caveat**: compute over a single storage binding of `N×8` B (the `qpos` buffer) needs the adapter's `maxStorageBufferBindingSize` ≥ `N×8`; below that, the binding must be chunked into multiple storage buffers each ≤ the adapter's limit (not implemented here — out of scope for the spike).
- **20M flags-compute allocation failure**: `THREE.WebGPURenderer` throws 4 `Uncaptured WebGPU GPUValidationError`s on every frame once `n=20000000`: the `qpos` storage-buffer binding used by the compute pass is `160,000,000` B, exceeding the device's default `maxStorageBufferBindingSize` (`134,217,728` B = 128 MiB, the WebGPU spec default that three requests unless `requiredLimits` is set at `renderer.init()`). The adapter itself reports `maxStorageBufferBindingSize` / `maxBufferSize` = `4,294,967,292` B (`navigator.gpu.requestAdapter()` → `adapter.limits`), so this is a **default-limits ceiling, not a hardware ceiling** — fixable by requesting a higher `maxStorageBufferBindingSize` in `requiredLimits` when creating the device (Task 6+). Largest N the compute pass supports unmodified: `floor(134,217,728 / 8) = 16,777,216` (2^24) points, since positions are the larger of the two storage bindings (`N×8` B vs `flags` `N` B).
  - The **render path is unaffected**: `qpos` is read in the vertex stage via `.toAttribute()` (an instanced vertex-buffer read, bound under `maxBufferSize`, not `maxStorageBufferBindingSize`), so 20M still renders correctly (`tris 40000001`, matches 2×N+1) — only the flags-compute-driven "east highlight" silently no-ops (flags buffer stays zero, so `isEast` is always false; base class colours still show).
  - Tab did **not** crash: it kept accepting the orbit script and updating the HUD after the errors.
- Console (2M, 10M): 0 errors, 2 benign warnings (same as above). Console (20M): the 4 `GPUValidationError`s above, 6 warnings total (2 benign + WebGPU's own duplicate `[Invalid BindGroup]`/`[Invalid CommandBuffer]` warning echoes), 0 crashes.
- `performance.memory` at 20M (Chromium, post-orbit): `usedJSHeapSize` 278.8 MB / `totalJSHeapSize` 280.3 MB / `jsHeapSizeLimit` 4,395.6 MB — JS heap only, does not include GPU buffers.
- Screenshot: (screenshot taken during the spike; not in repo).
- **Fix: `requiredLimits` raises the 20M compute ceiling, clamped to the adapter.** Default device (above) caps `maxStorageBufferBindingSize` at 128 MiB. `three` 0.186's `WebGPUBackend` forwards `parameters.requiredLimits` straight to `adapter.requestDevice()` (`WebGPUBackend.js:71,97,247`), and `WebGPURenderer`'s constructor forwards its own `parameters` object to the backend unchanged (`WebGPURenderer.js:75`) — so passing `requiredLimits` at `new THREE.WebGPURenderer({...})` construction is enough, no other plumbing needed. `SpikeApp.tsx` now calls `navigator.gpu.requestAdapter()` itself before constructing the renderer and passes `requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize }` — i.e. the adapter's *own* reported max, not a hard-coded guess, so `requestDevice()` cannot fail from asking for more than the adapter supports; if `requestAdapter()` returns `null`, `requiredLimits` is omitted entirely and the renderer falls back to whatever default WebGPU picks. Only `maxStorageBufferBindingSize` is requested: the compute-pass error at 20M cited only that limit (128 MiB default), and the default `maxBufferSize` (256 MiB) already covers the 160 MB position buffer needed at 20M, so raising it had no evidence behind it and was dropped. This adapter's (M4 Max, Metal) reported `maxStorageBufferBindingSize` = **`4,294,967,292` B** (~4 GiB, via `navigator.gpu.requestAdapter().limits`), so the requested limit at runtime was that full value, not a fixed 1 GiB.
  - **Result at 20M, re-measured (post round-2 fix, adapter-clamped)**: 0 `GPUValidationError`s (console: 0 errors, 2 benign warnings, same as 2M/10M). `#compute`: `flags compute: 5000000 words, submit 1.10 ms, gpu 0.524 ms` (nonzero, real dispatch). HUD after settle: `65.54 ms  15 fps  draws 2  pts 0  tris 40000001` — frame time/fps unchanged from the render-only numbers in the table above (render path was never the bottleneck here; raising the limit only unblocked the compute pass). East half renders red (screenshot taken during the spike; not in repo), west half keeps class colours — flags buffer is now actually written.

## Phase 1: data pipeline

**Source tile**: Vancouver Open Data 2022 LiDAR, tile `491000_5458000` (downtown), `https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip`. Licence: Open Government Licence – Vancouver (`https://opendata.vancouver.ca/pages/licence/`). Imported as `data/raw/vancouver-downtown.las`, CRS UTM 10N metres (WKT VLR).

### Point format (`points.bin`)

8 bytes/point: 4 little-endian `uint16` words, `[x, y, z, packed]`.
- `x/y/z`: quantized position. `quantize_cloud` maps the float64 metre AABB to `q = round((p − min) / (max − min) × 65535)` per axis, clamped to `QMAX = 65535`; a degenerate axis (`min == max`) quantizes to all zero. Dequantizing (`p ≈ min + q/65535 × (max − min)`) is accurate to within half a quantization step per axis.
- `packed`: `intensity8 | (cls << 8)`. Intensity is the raw LAS `uint16` intensity normalized to `uint8` by p1–p99 clamping (`p99 == p1`, i.e. no intensity recorded → all zero, no divide-by-zero). Classification is the raw ASPRS `uint8` code, unclamped — `packed >> 8` recovers it directly from a `<u2` read of word 3.

### Manifest schema (`manifest.json`)

```json
{ "version": 1, "name": "vancouver-downtown",
  "source": "https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip",
  "license": "Open Government Licence – Vancouver",
  "crs": "<WKT string from the tile's WktCoordinateSystemVlr>", "units": "m",
  "bounds": {"min": [491000.0, 5458000.0, -39.07], "max": [491999.999, 5458999.999, 398.347]},
  "pointCount": 20000000, "bytesPerPoint": 8, "file": "points.bin",
  "classMap": {"1": "Unclassified", "2": "Ground", "3": "Low Vegetation",
               "5": "High Vegetation", "6": "Building", "7": "Low Point (Noise)"},
  "chunks": [{ "offset": 0, "count": 78432, "bounds": {"min": [x, y, z], "max": [x, y, z]} }, "..."] }
```
`classMap` lists only classes present in that dataset (both the full and demo manifests carry all six classes above, matching the raw tile). `chunks[i].offset` is in points; `offset_{i+1} = offset_i + count_i`, contiguous and ascending from 0. Chunk `bounds` are tight per-chunk AABBs in metres. `file` resolves relative to the manifest's own URL.

### Chunking

64 m XY grid, anchored at the dataset's own `bounds.min` (not per-chunk). Cell index `(ix, iy) = floor((xy − min) / 64)`, clipped to `ceil(span / 64) − 1` per axis so a point exactly on the max edge folds into the last row/column instead of overflowing a phantom extra cell. Chunks are iterated row-major on `key = iy × nx + ix`; empty cells are omitted entirely (no zero-count entries in `manifest.chunks`). Within each chunk, point order is a seeded shuffle (`numpy.random.default_rng(seed).shuffle`) before writing — so any prefix of a chunk is a uniform random subsample of that chunk. That's what lets the viewer's point-budget slider truncate each chunk's read (fewer bytes fetched per chunk) without introducing spatial or class bias; verified by test: the first 10% of each chunk's classes match the full chunk's class proportions within ±3 pp. `--demo` does not requantize — it takes a seeded global permutation of the already-quantized full-set points and re-chunks, reusing the full set's `bounds` exactly, so full and demo manifests always share identical bounds.

### Unit handling

`resolve_units` resolves horizontal and vertical linear units *separately* (a State Plane tile can carry US-survey-foot XY with NAVD88-metre Z), in this order: explicit `--units`/`--z-units` flags win outright when both are given; otherwise a WKT VLR (`WktCoordinateSystemVlr.string`), searched in both `header.vlrs` **and** `header.evlrs` (the SF 2024 3DEP tile kept it in an EVLR only; `header.evlrs` is `None` on LAS 1.2, so both must be checked); otherwise GeoTIFF keys. The horizontal unit is the last `UNIT[`/`LENGTHUNIT[` keyword before any `VERT_CS[`/`VERTCRS[` block, the vertical unit is the first one after it. `_UNIT_RE = re.compile(r'(?<![A-Z])(?:LENGTH)?UNIT\["([^"]+)"')` matches only whole `UNIT[`/`LENGTHUNIT[` keywords — the negative lookbehind rejects `ANGLEUNIT[` (the GEOGCS degree unit embedded earlier in the same WKT), which would otherwise be picked up as a spurious linear unit. Absent a WKT VLR (older LAS 1.2/1.3 tiles carry GeoTIFF keys instead), `GeoKeyDirectoryVlr` keys are read: `3076` (`ProjLinearUnitsGeoKey`, horizontal) and `4099` (`VerticalUnitsGeoKey`, vertical), values `9001` metre / `9002` international foot / `9003` US survey foot. If neither source resolves a unit, `resolve_units` raises unless the corresponding `--units`/`--z-units` flag was given explicitly.

This machinery was exercised, and ultimately not enough on its own: three USGS 3DEP tiles were vetted and rejected as the dataset source before Vancouver — `la_6482_1836a` (LA 2016), `sf_b23_05050270` (SF 2024), `nyc_sandy_18TWL835045` (NYC Sandy 2013). All three resolve units fine but carry only the 3DEP baseline classification set (1 Unclassified, 2 Ground, 7 Low Point/Noise, 9 Water, 17 Bridge Deck, 18 High Noise) — no building or vegetation classes at all — so none can pass the vetting rule (class 6 Building ≥ 3%, class 5 High Vegetation ≥ 3%, raw count ≥ 5M) regardless of correct unit resolution. Vancouver 2022 open data classifies building and vegetation directly and replaced 3DEP as the source (master spec amendment A10).

### Raw tile

51,494,885 points.

`--stats` class table (Task 5):
```
points: 51,494,885
bounds (m): min [491000.0, 5458000.0, -39.303] max [491999.999, 5458999.999, 398.347]
unit source: wkt (xy ×1.000000, z ×1.000000)
classes:
    1 Unclassified                  6,720,654  13.05%
    2 Ground                       12,081,486  23.46%
    3 Low Vegetation                  102,377   0.20%
    5 High Vegetation               7,807,894  15.16%
    6 Building                     24,495,564  47.57%
    7 Low Point (Noise)               286,910   0.56%
intensity p1/p50/p99: 4 / 157 / 832
```
Load time (Task 5 `--stats` run, cold cache): 1.2 s (51,494,885 points).

### Preprocess build and outputs

**Preprocess build** (`--max-points 20000000 --demo 2000000 --cell-size 64 --name vancouver-downtown`): load 0.9 s (warm cache), `total 8.3 s` (script-reported), wall clock (zsh `time`) `6.51s user 1.20s system 91% cpu 8.409 total`. Well under the spec's 2-minute target for 20M points on an M4 Max.

**Full dataset** (`data/processed/vancouver-downtown/`): 20,000,000 points, 256 chunks, `points.bin` 160,000,000 bytes.

**Demo dataset** (`data/processed/vancouver-downtown/demo/`): 2,000,000 points, 256 chunks, `points.bin` 16,000,000 bytes.

Both share bounds (m): min `[491000.0, 5458000.0, -39.07]` max `[491999.999, 5458999.999, 398.347]`.

### Hosting

Both datasets (`demo-*`, `full-*`) are flat GitHub Release assets on `v0.1-data`; `scripts/fetch-data.mjs` (`npm run data:demo`/`npm run data:full`) downloads and renames them into `public/data/<name>/{manifest.json,points.bin}`, skipping any file whose local size already matches the response `Content-Length`.

`check_hosting.py` against `demo-points.bin` and `full-points.bin` (Task 7, verbatim outcome):
- Redirect chain: `302 github.com/…/releases/download/v0.1-data/<asset>` → `206 release-assets.githubusercontent.com/…` (a signed, time-limited asset URL).
- `range 206`: **PASS** (status 206). `content-range`: **PASS** (`bytes 0-15/16000000` / `bytes 0-15/160000000`, 16-byte body). `accept-ranges` (informational): **PASS** (`bytes`).
- `cors hop 1` (the `github.com` 302) and `cors hop 2` (the `release-assets.githubusercontent.com` 206): **FAIL** on both — no `access-control-allow-origin` header on either hop, for any `Origin` sent.
- Exit code: 1 (CORS failure blocks an otherwise-clean Range result).

**Decision (user)**: keep the release as-is. The viewer loads `public/data/…` same-origin — the release URLs are only ever fetched by `scripts/fetch-data.mjs` during `npm run data:*`, never by the browser directly — so the missing `access-control-allow-origin` on the GitHub asset host does not block anything in-repo. Cross-origin hosting (e.g. a Lab-page embed that fetches the release URLs directly from the browser) is deferred to Phase 6.

**Loader contract** (per spec, for Phase 2+): chunks are fetched via HTTP `Range` requests against `points.bin`, using each chunk's `offset`/`count` from the manifest. If a response comes back `200` instead of `206` (no `Content-Range` — some hosts ignore `Range` on small files or cache misses), the loader falls back to a single full fetch of `points.bin` and slices chunks out of the buffer locally, rather than treating it as an error.

### Memory

`load_cloud` holds the whole tile as float64 XYZ (24 B/point) plus `uint16` intensity and `uint8` classification until `quantize_cloud` converts XYZ to `uint16`; at the raw tile's 51,494,885 points that's ~1.2 GB for XYZ alone while loading — consistent with the spec's ~1 GB-peak-at-20M estimate and the sub-9 s wall time observed (no swapping).
