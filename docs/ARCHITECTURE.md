# Architecture

## Deferred

Known gaps carried across phases. Each entry names the owner phase (or "any") and what triggers the fix.

**Hosting / embedding**
- Release `v0.1-data` assets have no `access-control-allow-origin` (both hops). The viewer loads same-origin from `public/data/`; a cross-origin host (website static + `.htaccess` CORS, or a bucket) is needed before the Lab embed. Owner: Phase 6. Note: the 160 MB full bin can't go through the `portfolio-web` git repo (GitHub 100 MB limit).
- `check_hosting.py` acceptance "passes on both bins" and Phase 2 "full set streams with 206 from the release URL" are unmet by design (same-origin only; Range path covered by mocked-fetch vitests and Vite's 206 responses).

**Renderer / GPU lifetime**
- r3f 9.7 never calls `gl.dispose()` on a `WebGPURenderer` at `<Canvas>` unmount; renderer + `qpos`/`flags` buffers live until page unload (see "GPU lifetime"). Owner: whichever phase adds remount/dataset switching (Phase 5 export re-open is the first candidate). Phase 4 adds ~214 MB of compute buffers to the same leak.
- `RenderPipeline` + its pass target (Phase 3) join the renderer leak: `PostHandle.dispose()` disposes both on `<PostPass>` unmount, but the renderer itself is never disposed, so in practice neither ever runs today (no unmount path in the app). Owner: same as above.
- `DatasetLimitCheck` reads `renderer.backend.device.limits` — a second backend read beyond the `compatibilityMode` one the spec allows. Replace with `renderer.getDevice?.()`/adapter limits captured in the factory if three exposes one. Owner: any.
- `<Scene>` has no `key={manifestUrl}`; the cached renderer + `DatasetLimitCheck` handle a manifest swap, but sprites/material are rebuilt through `loaded` identity only. Owner: Phase 5 (export re-open).

**Loader**
- After ≥1 chunk uploaded, a worker `error` leaves `status` at `'loading'` forever (only `error` text is set; nothing gates on `status === 'loading'` today). Owner: any UI that adds a loading overlay.
- `url` is not re-synced to a fresh `response.url` after an origin retry; the discovery fetch is not retried; a mid-flight abort is untested; sibling workers are not cancelled on a chunk error. All cost/coverage only.
- `loader.worker.ts` `if (msg.pos)` seeding and the worker entry have no unit test (module workers aren't testable under the node vitest env); browser-verified via the first-five-chunk log.
- `validateManifest` accepts `count ≤ 0`, non-integers and `pointCount === 0` (→ `storage(..., 0)`).

**Viewer UI**
- `id="hud"` on the viewer root child duplicates with several viewers on one page; the Playwright checks read `#hud`. Switch to `data-pcv-hud` + a bench handle in Phase 6.
- `H` toggles the HUD (Phase 2) but the Phase 5 spec assigns `H` = hide — see the spec review.
- No unit tests for `Panel`, `useLoader`; `ASPRS_FALLBACK` is named in the Phase 2 Interfaces but the code uses `ASPRS_COLORS[-1]`.
- `dpr?: number` on `PointCloudViewer` (Phase 3, `?dpr=` on the dev harness, clamped `[0.5, 4]`) exists to drive perf-row measurement (DPR 2 numbers below) without editing source; not exercised as a public embedding API beyond that.

**Post-processing**
- 20M EDL cost at 100 % budget sits below the HUD EMA's ±1 ms toggle-to-toggle noise (Phase 3 measured section below); a GPU timestamp query around the pipeline's `render()` would give a real per-pass number. Owner: whichever phase next touches perf tooling (Phase 4 already wires `trackTimestamp`/`resolveTimestampsAsync` for compute).
- `PCFSoftShadowMap has been removed` fires once per `renderer.setSize` (every resize and every `dpr` change), on top of the one-time Phase 2 warning; pre-existing r3f default shadow config, benign, could be silenced with an explicit `shadows={false}` on `<Canvas>`. Owner: any.

**Compute (Phase 4)**
- Hash buffers (`cellStart` 16.8 MB, `cellCursor` 16.8 MB, `blockSums`, `sorted` 80 MB at 20M) stay allocated after a build (three has no API to free a `StorageBufferAttribute`'s GPU buffer; `Node.dispose()` only emits an event). Rebuilds reuse them; with `normals` 80 MB + `ao` 20 MB they are the ~214 MB the renderer-leak entry above counts. Owner: same as the renderer leak.
- `K = 16` neighbours is a constant in `compute/params.ts`; no compiler spill was observed on Metal, so the `K = 12` fallback was never exercised. Owner: any port to a GPU where the normals kernel spills.
- Verify is disabled above `BENCH_CAP` (2M): the CPU bench runs a per-chunk prefix subsample there, whose neighbourhoods differ from the full set, so the readbacks are not comparable. A same-subset GPU build (or a full 20M CPU run, ~2.5 min extrapolated) would enable it. Owner: any.
- `scanBlockSums` is a single-thread serial loop over `T/256` block sums (16,384 at 20M; 1.70 ms for the whole scan row) — the serial floor if `T` grows past 2²². Owner: any larger tile.
- Build wall time exceeds the GPU sum by ~35–50 ms at 2M and ~950 ms at 20M (each `timedCompute` awaits `computeAsync` then `resolveTimestampsAsync`, interleaved with 35 ms render frames); the panel shows both, only `gpu` is the kernel cost. A single command encoder for all passes would close the gap. Owner: Phase 6 perf tooling.
- StrictMode mounts `<ComputeRunner>` twice; the first pipeline's hash buffers linger until unload in DEV only (same `dispose()` limitation).
- CPU bench pins the loader worker (~11 s at 2M, 14.5 s for the 20M subsample); a `dispose` during a bench terminates the worker and the pending promise resolves `null`.
- Panel "Benchmark (CPU, N pts)" title shows `min(total, BENCH_CAP)` = 2,000,000 on the full set while the actual subsample is 1,999,872 (256 × floor(2M/256)); the table row uses the real `bench.n`.

**Tools (Phase 1)**
- `check_hosting.walk()` has only a DNS-failure test (no local-http-server redirect test); `evaluate([])` raises; hop-cap exhaustion is silent.
- `--stats` zero-intensity "no division warning" is not asserted; `rec.astype("<u2")` makes a redundant 160 MB copy; the DNS-failure test does a live `.invalid` lookup (slow on sandboxed resolvers).
- `--import` derives the tile URL from the zip stem (`--url` overrides); a malformed zip prints a raw traceback.

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

Keyboard shortcuts (`F` refit, `H` toggle HUD) are bound via `onKeyDown` on the viewer's root `<div tabIndex={0}>` only — nothing attached to `window`/`document` — so they're focus-scoped and never hijack the host page.

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

`T = tableSizeFor(N) = nextPow2(max(1024, N/8))`: **262,144 at 2M, 4,194,304 at 20M** (`compute/params.ts`). Cell size = radius; cell key = `(x·73856093 ^ y·19349663 ^ z·83492791) & (T−1)` on the non-negative bounds-relative integer cell coordinates (kernels work in `q × dqScale`, no centroid — ruling 1, `dequantScale(manifest.bounds)` shared with the material). Collisions merge cells; the `d² ≤ r²` test keeps results exact, collisions only cost candidate work. Measured at 2M, radius 3 × spacing = 2.12 m: **232,825 occupied cells of 262,144 (occupancy 0.888)**, `cellStart[T] = 2,000,000` (Task 5's readback: 232,828 occupied, max 59 points per cell), and the GPU `cellStart` matched the CPU `buildGrid` oracle at **0 of 262,145 entries different** (Task 4 spike). Radius = `radiusMul × spacing`, `spacing = sqrt(areaXY / pointCount)` from the manifest's full count (0.707 m on the demo, 0.224 m on the full set); slider 1–6×, default 3× (2.12 m demo / 0.67 m full).

### Pass order and dispatch shapes

`build(radius)` runs seven dispatches, timed as five rows: `zero` (untimed bookkeeping: `atomicStore(&cellStart[i], 0)` over `T+1`, ruling 6 — no 16.8 MB CPU upload) → **count** (`atomicAdd` per point, `.compute(N, [64])`) → **scan** = `reduceBlocks` (`T/256` threads, serial 256-cell sum each) + `scanBlockSums` (one thread, serial exclusive scan over `T/256` sums: 1,024 at 2M, 16,384 at 20M) + `scanCells` (`T/256` threads, writes `cellStart` exclusive prefix, `cellCursor = cellStart`, `cellStart[T] = N`) → **scatter** (`atomicAdd` on `cellCursor`, writes `sorted`) → **normals** (thread per point) → **ao** (thread per word, `ceil(N/4)` threads, whole-word store). No `var<workgroup>`, no barriers: the block-serial scan is ~8M serial adds at T = 2²² and vitest-verifiable through the CPU mirror (`compute/cpu/hash.ts`); the three dispatches share one "scan" timing row. All point-parallel kernels use `instanceIndex` with an `i ≥ N` guard and `.compute(N, [64])`; three splits dispatches above 65,535 workgroups itself (A9) — verified by the 20M build writing every normal.

### Atomics, helpers, kernel rules

`cellStart`/`cellCursor` are `storage(attr, 'uint', n).toAtomic()` once each — the buffer struct becomes `value: array<atomic<u32>>`, so every `wgslFn` that touches them declares `ptr<storage, array<atomic<u32>>, read_write>` and the non-atomic kernels (`zero`, `reduce`, `scanCells`, `normals`, `ao`) go through `atomicLoad`/`atomicStore` (WGSL has no plain access to an atomic array). Compiled and ran first try; the two-node fallback was not needed. Shared WGSL (`pcvDecodePos`, `pcvCellKey`, `pcvOctEncode`, `pcvOctDecode`, `pcvSmallestEigenvector`) lives in one `wgsl()` code node passed as the `includes` of every `wgslFn` (`compute/wgsl/helpers.ts`). The Phase 0 kernel rules held throughout: every kernel returns `u32` and its call is `.toVar()`-ed (`call()` in `pipeline.ts` casts the untyped `wgslFn` result once); no `toReadOnly()`; `ao` and `flags` writes are thread-per-word; the `qpos` storage node is the same one the material reads.

### Normals and AO

`normalsKernel`: 27-cell neighbourhood (`c0 ± 1`, skipping negative cells), K = 16 nearest by insertion sort in registers (`array<f32,16>` + `array<u32,16>`), PCA over the point plus its ≤ 16 neighbours (n + 1 samples), smallest eigenvector via 3×3 cyclic Jacobi (8 sweeps, Numerical Recipes rotation, identical in WGSL and TS), oriented to `nz ≥ 0`, oct-encoded as two **unsigned** u16 (`round((p·0.5+0.5)·65535)`, decoded `/65535` on both sides — controller ruling `bb959f2`). Degenerate (< 3 neighbours or the eigen solve rejects) → the +Z word `0x80008000` (WGSL `round(32767.5)` → 32768 half-to-even; in JS the constant must be written unsigned, `(32768 | 32768 << 16) >>> 0`, or it compares as a negative int32 and never matches a `Uint32Array` element). `aoKernel`: per point, `1 − above/total` over neighbours within the radius, "above" = `d·n > eps` with `eps = 0.02 × radius`; `total = 0` → 1; byte = `round(a·255)`. Readback sanity at 2M: **+Z words 117,790 / 2,000,000 = 5.9 %** — mostly true +Z normals on flat, quantised ground (the CPU oracle agrees on 117,788 of them), not the fallback path alone; 99.9997 % of normals have `nz ≥ 0`; 1,724,782 distinct words; **AO mean 0.7046**.

### Shading (`render/pointMaterial.ts`)

`shading` uniform (`flat 0 / lit 1 / litAo 2`). The vertex stage oct-decodes `normalsNode[gi]`, transforms with `transformNormalToView`, and lights as a headlight `lambert = max(|n · v|, 0.15)` (`abs` = camera-facing flip, so orientation sign never matters at render); AO byte from `aoNode[gi >> 2]`. The three modes are one **branchless** blend — `lit = step(0.5, shading)`, `useAo = step(1.5, shading)`, `light = mix(1, lambert · mix(1, ao, useAo), lit)` — and `colorNode = lut × vertexStage(light)`, so the storage reads and the lighting evaluate once per vertex. The nested-`select` version rendered nothing in flat/litAo (three-0.186 finding recorded in the Phase 0 rules below). `lambert` is evaluated in flat mode too; pre-build all-zero normal words decode to `(0,0,−1)`, no NaN. Frame cost: 2M `4.17 ms` in flat, lit and lit + AO (vsync floor); 20M `34–37 ms` before the build, `34.7–35.7 ms` after, `35 ms` in lit + AO — no measurable change, `draws 257 tris 40000001` unchanged.

### Timing semantics (`compute/timing.ts`)

`timedCompute` = `performance.now()` around `renderer.computeAsync` (**submit**: CPU encode + submit, does not await GPU completion) then `resolveTimestampsAsync(TimestampQuery.COMPUTE)` (**gpu**: timestamp-query delta, `null` when `hasFeature('timestamp-query')` is false; the renderer is built with `trackTimestamp: true`). Only the resolve result is used, never `renderer.info` (ruling 7 — the HUD resets it). Metal quantises the GPU value to multiples of ~0.0655 ms (0.066 / 0.131 / 0.197 at the hash passes). `elapsedMs` (panel "wall") spans the whole `build()` including the six awaited round-trips; at 2M the warm wall (129–138 ms) exceeds the GPU sum (88–93 ms) by ~40 ms, at 20M the gap is ~950 ms (see Deferred) — cite `gpu`, not wall, as kernel cost.

### CPU path (`compute/cpu/*`, `loader/loader.worker.ts`)

Same algorithms in TS over typed arrays (`decodePositions` + `buildGrid`, `computeNormals`, `computeAo`; vitest: grid+kNN vs brute force, Jacobi on known matrices, oct round-trip < 0.5° (test bound; measured worst over the test's 2,000 PRNG vectors 0.0035° at [0.698, −0.427, −0.575], +Z 0.0012°), exclusive scan vs `reduce`, plane AO = 1, corner AO 0.68 — 27 tests across `compute/params.test.ts`, `compute/cpu/*.test.ts`, `compute/verify.test.ts`). Runs in the existing loader worker (ruling 4: `cpuBench`/`cancelBench` on `LoaderIn`, `benchProgress`/`benchDone`/`benchCancelled` on `LoaderOut`), cooperative in 100k-point slices with a `setTimeout(0)` yield so a cancel lands between slices; results transferred back. Input = `benchWords(qpos.array, chunks, min(N, BENCH_CAP))`: the whole array when `N ≤ 2M` (then `slice()`d so the attribute's own buffer is never transferred), else the first `floor(n/chunks)` points of every chunk packed contiguously without padding — 256 × 7,812 = **1,999,872** points on the full set. The bench posts `store.bench`; DEV hook `window.__pcvBench = { state, run }` (separate from `window.__pcvCompute = { build, readback, tableSize, timings, state, cpuCellStart }`, owned by `<ComputeRunner>`'s effect). `readback()` throws before the first build (`getArrayBufferAsync` on an attribute no pipeline has bound). Cancel verified: Cancel ~3 s in → `status 'cancelled', progress 0.43`, re-run works.

### Verify (`compute/verify.ts`)

`compareResults(gpuNormals, gpuAo (packed words), cpuNormals, cpuAo, n)` → sign-insensitive angle per point (`acos(|a·b|)`), median/max, `+Z` count on the GPU side, AO MAE normalised to [0,1], non-finite count. Enabled only when `pointCount ≤ BENCH_CAP` (same point set on both sides); on the full set the panel shows "Verify needs the same points on both sides — demo set only." **2M result: `n 2,000,000 · median 0.000° · max 80.77° · AO MAE 0.0001 · non-finite 0 · +Z 117,790`.** Tail: ≤ 0.1° 1,999,570 · (0.1, 1]° 217 · (1, 5]° 123 · (5, 20]° 76 · > 20° 14 — fraction > 1° = 1.07e-4, all on near-isotropic neighbourhoods where f32 (WGSL) vs f64 (JS) Jacobi picks a different smallest eigenvector; neither side degenerate. AO: 52,676 of 2M bytes differ, 51,808 by exactly 1 LSB (WGSL `round()` is ties-to-even, `Math.round` is half-up), 868 by more (points whose normal differs). Verify reports MAE with no gate; the median is the acceptance number.

### Measured

Radius 3 × spacing; GPU = timestamp query per pass; console 0 errors in every run (2 benign warnings on the demo, 3 on the full set — `PCFSoftShadowMap` fires once per StrictMode mount).

| pass | 2M gpu ms (Task 5 / Task 6 / this task) | 20M gpu ms (cold / warm) | CPU ms @2M (3 runs) | CPU ms, 20M subsample (1,999,872 pts) |
|---|---|---|---|---|
| count | 0.07 / — / 0.07 | 1.44 / 1.84 | — | — |
| scan | 0.13 / — / 0.20 | 1.64 / 1.70 | — | — |
| scatter | 0.20 / — / 0.13 | 5.51 / 5.51 | — | — |
| hash (sum) | 0.40 / 0.52 / 0.40 | 8.59 / 9.05 | 17.4 / 17.3 / 18.6 | 17.4 |
| normals | 55.31 / 55.64 / 55.25 | 814.42 / 818.15 | 5,751 / 6,247 / 5,781 | 7,167 |
| ao | 36.96 / 31.78 / 31.52 | 717.03 / 704.25 | 4,662 / 4,638 / 4,868 | 6,906 |
| total gpu | 92.67 / 87.94 / 87.17 | 1,540.04 / 1,531.45 | | |
| wall | 129 / — / 138 ms | 2,519 / 2,488 ms | ~11 s | 14.5 s |

- 2M target < 200 ms GPU: met (88–93 ms). First-ever build after a reload includes pipeline compile (Task 5: normals 56.75, ao 36.70, wall 208 ms; Task 4 hash-only: 181.8 ms cold → 20.1 ms warm).
- 20M: `normals` 818 ms + `ao` 704 ms ≈ 17× the 2M cost for 10× the points — the full set is denser per cell (0.224 m spacing, radius 0.67 m) and the 27-cell scan touches more candidates. Hash passes scale ~20×. `T = 4,194,304`, `builtRadius 0.6708 m`.
- CPU vs GPU at 2M: normals ~100×, ao ~150×; the CPU hash (~17 ms) is far below the GPU-side wall because `performance.now()` in a worker is coarse and decode + grid build over 2M points is genuinely cheap next to kNN.
- Screenshots (`.playwright-mcp/`): `shading-flat.png`, `shading-lit.png`, `shading-litao.png`, `shading-litao-close.png` (2M, EDL off close-up: facets from compute shading alone, no 16×16 chunk-grid seams), `shading-litao-20m.png` (20M, Lit + AO, EDL on, HUD `36.07 ms 28 fps draws 257 tris 40000001`, panel table visible).
- Panel: Compute group (radius slider `1–6×` step 0.5 with the metre readout, Build button → "Building…"/"Built", timing table submit/gpu per pass + total + wall, Shading select with lit/litAo disabled until built; Build re-enables when the radius moves — ruling 5); Benchmark group (Run CPU / Cancel with progress %, GPU-vs-CPU ms table labelled `(all)`/`(cap)` when the bench ran on a subsample, Verify button gated on built + `N ≤ 2M`, summary line).

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
