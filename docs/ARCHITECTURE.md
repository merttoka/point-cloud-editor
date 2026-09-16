# Architecture

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

No other persistent per-point CPU copy: the loader worker transfers each chunk's buffer out and keeps nothing.

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
