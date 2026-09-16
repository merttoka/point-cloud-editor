# Phase 2: Viewer — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §2, §7.2 (amendments A3, A6, A7 apply)

## Goal

`PointCloudViewer` streams a manifest dataset progressively into one global GPU buffer and renders it as per-chunk sprites with orbit, point budget, point size, three colour modes, a flags buffer wired for later phases, a HUD, theming, and focus-scoped keys. The spike is deleted at the end of this phase.

## Scope

In: everything under `src/viewer/` listed below, `App.tsx` mounting the viewer on `/data/demo/manifest.json`, vitest + Playwright smoke, README usage/controls, ARCHITECTURE viewer sections.
Out: EDL (3), compute (4), editing (5), LOD, manual chunk visibility beyond frustum culling, touch gestures beyond what OrbitControls gives.

## Interfaces

### Layout
```
src/viewer/
  PointCloudViewer.tsx        # public: { manifestUrl, theme?: 'dark'|'light', className? }
  state/store.ts              # createStore / useStore(selector) on useSyncExternalStore; one store per viewer via context
  format/quant.ts             # exists (phase 0)
  loader/manifest.ts          # fetchManifest(url) → validated Manifest
  loader/chunkQueue.ts        # pure priority queue: distance² camera→chunk AABB centre
  loader/loader.worker.ts     # Range fetches, full-fetch fallback, transfers
  loader/useLoader.ts         # worker lifecycle, camera → priorities, chunk → upload + store
  render/Scene.tsx            # <Canvas> with the phase-0 renderer factory, camera fit, OrbitControls
  render/PointBuffers.ts      # global qpos + flags storage attributes, range upload
  render/pointMaterial.ts     # one PointsNodeMaterial (TSL) for all chunks
  render/ChunkSprites.tsx     # one Sprite + tiny PlaneGeometry per chunk
  render/colormaps.ts         # 256×1 LUT DataTextures
  ui/Panel.tsx  ui/Hud.tsx  ui/*.module.css
  theme/tokens.module.css     # --pcv-* with Lab fallbacks
```

### Store
```ts
interface ViewerState {
  manifest: Manifest | null
  status: 'idle' | 'loading' | 'ready' | 'error'; error?: string
  loaded: { points: number; chunks: number }
  budget: number                       // 0..1, default 1
  pointSize: number                    // px at reference distance, 1..8, default 2
  colorMode: 'height' | 'intensity' | 'class'
  colormap: 'viridis' | 'turbo' | 'grayscale'   // continuous modes only
  showHud: boolean
}
```
`createStore(initial)` returns `{ get, set, subscribe }`; `useStore(selector)` wraps `useSyncExternalStore`. No zustand (A7).

### Loader
- Main: `fetchManifest` validates `version === 1`, `bytesPerPoint === 8`, chunks contiguous and summing to `pointCount`; then `PointBuffers.create(N)`; then spawns the worker (`new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })`) with `{ binUrl, chunks: {offset,count}[] }`.
- Worker: queue ordered by `chunkQueue` priority; camera position arrives as `{type:'camera', pos}` (main throttles to 100 ms) and re-sorts; concurrency 4; per chunk `fetch(binUrl, { headers: { Range: bytes=o*8-(o+c)*8-1 }, signal })`. A `200` without `Content-Range` aborts the queue and switches to one full fetch sliced locally. Each chunk posts `{type:'chunk', index, words: Uint32Array}` with the buffer transferred. `{type:'dispose'}` aborts everything. The worker keeps no copy: the main-thread attribute array is the CPU copy (A6).
- Main on chunk: `buffers.uploadRange(offset, words)` → store `loaded` → that chunk's sprite gets a non-zero `count`.

### GPU buffers (`PointBuffers`)
- `qpos = new StorageBufferAttribute(new Uint32Array(N * 2), 2)`, node `storage(qpos, 'uvec2', N)`; vertex reads `qposNode.element(gi)` with `gi = userData('chunkBase','uint').add(instanceIndex)`. No per-chunk attribute (A3).
- `flags = new StorageBufferAttribute(new Uint32Array(ceil(N / 4)), 1)`, zeroed; vertex reads `flags.element(gi >> 2) >> ((gi & 3) * 8) & 0xff`; bits hidden (1) or deleted (4) move the point to `vec3(1e30)` so it clips. Never `toReadOnly()`.
- `uploadRange(offset, words)`: `array.set(words, offset*2)`, `addUpdateRange(offset*2, words.length)`, `needsUpdate = true`. WebGPU attribute utils honour `updateRanges` (verified in `WebGPUAttributeUtils.updateAttribute`).
- If `N × 8 > device.limits.maxStorageBufferBindingSize` → `status: 'error'` with a "dataset too large for this GPU" message (renderer factory already requests the adapter's limit).

### Material (`pointMaterial.ts`)
`PointsNodeMaterial` on `Sprite`, `sizeAttenuation = false` (phase-0 mechanism).
- Position: unpack `x, y, z` from the uvec2; `world = vec3(x,y,z) * dqScale + dqMinCentred` where `dqMinCentred = bounds.min - centroid` (world centred at the bounds centroid, camera target at the origin).
- Size: `sizeNode = clamp(pointSize * refDist / -positionView.z, 1, 8)` px, `refDist` = camera fit distance. Perspective attenuation in px, `sizeAttenuation` stays off.
- Colour: `t` = height `z_q / 65535`, intensity `(packed & 0xff) / 255`, or class `cls / 255`, chosen by a `mode` uniform; `colorNode = texture(lut, vec2(t, 0.5)).level(0)` (emits `textureSampleLevel`, valid in the vertex stage). `lut` is swapped by mode/colormap: continuous LUTs for height/intensity, the categorical ASPRS LUT for class.
- Uniforms: `dqScale`, `dqMinCentred`, `pointSize`, `refDist`, `mode`; per-object `userData.chunkBase`.

### Chunk sprites
Per manifest chunk: `Sprite(material)`, own `PlaneGeometry(1,1)` (bounds live on geometry, so no sharing), `userData.chunkBase = offset`, `count = loaded ? ceil(chunk.count * budget) : 0` (chunk prefix = uniform subsample, Phase 1 shuffle), `geometry.boundingBox/boundingSphere` from centred chunk bounds, `intersectsFrustum` overridden to `frustum.intersectsObject(sprite)` (phase 0). ~256 draw calls at the default 64 m cell on a 1 km tile.

### Colormaps
`colormaps.ts` builds 256×1 RGBA8 `DataTexture`s: viridis and turbo from published polynomial fits, grayscale linear, ASPRS categorical (0 never-classified grey, 1 unclassified, 2 ground, 3–5 vegetation greens, 6 building, 7 noise, 9 water, others fallback), `NearestFilter`, no mips.

### Camera
`OrbitControls` (`makeDefault`, damping), up `+Z`. On manifest: `refDist = radius / sin(fov / 2) * 1.1`, position `centre + normalize(1, -1, 0.8) * refDist`, target origin. `F` refits.

### UI, theme, keys
- Panel (CSS module): name, loaded/total + progress bar, budget slider, point size slider, colour mode, colormap, HUD toggle.
- HUD: phase-0 HUD generalised: frame ms EMA, fps, draws, loaded/total, budget %. `info.autoReset=false` in the renderer factory; HUD resets after reading.
- Theme: `theme` prop sets `data-theme` on the viewer root. `tokens.module.css` defines `--pcv-bg`, `--pcv-surface`, `--pcv-card`, `--pcv-text`, `--pcv-text-2`, `--pcv-muted`, `--pcv-border`, `--pcv-accent`, `--pcv-font`, `--pcv-mono`, `--pcv-radius` as `var(--bg, #0a0a0a)` etc., i.e. Lab's tokens when embedded, own fallbacks standalone, with a `[data-theme="light"]` fallback set. No global CSS.
- Keys: root `tabIndex={0}`, `onKeyDown` on the root only: `F` fit, `H` HUD. Nothing on `window`.
- States: no WebGPU → message; manifest error → message; too large → message.

## Acceptance criteria

- Demo on localhost: first chunk visible < 1 s after the manifest, 2M fully loaded < 3 s.
- Full set from the release URL streams with `206` responses, nearest chunks first (dev log of upload order); the full-fetch fallback is covered by a vitest with mocked `fetch`.
- Budget slider changes instance counts the same frame; HUD `tris = 2 × visible + 1`.
- 20M at budget 100 %, size 2 px: fps ≥ the phase-0 baseline (~15 at DPR 1); recorded.
- Per-chunk upload cost measured and shown not to scale with N (partial update works); if the first `needsUpdate` uploads the whole buffer once, that is recorded as a one-time cost.
- Three colour modes and both themes screenshot-verified; no console errors.
- `src/spike/` deleted; `App.tsx` mounts the viewer; `vite build` bundles the worker.

## Risks and spikes

- `userData('chunkBase','uint')` per-object read on WebGPU → fallback: one material per chunk (same node graph, pipeline cached by shader hash).
- Partial upload via `updateRanges` on a storage attribute → measure; fallback: accept a one-time full upload on first update, then ranges.
- ~256 sprites: verify draw-call count and that per-object uniforms don't reallocate bind groups each frame.
- Main-thread `Uint32Array(N*2)` (160 MB at 20M) is now the only CPU copy; memory table in ARCHITECTURE updated (A6).
- `Sprite` + `PointsNodeMaterial` `positionNode` with hidden points at `1e30` must not produce NaN in `setupVertexSprite`; use a large finite value.

## Tests

vitest (node): manifest validation (good, bad version, non-contiguous chunks), `chunkQueue` ordering and re-sort, Range header math, fallback slicing of a full buffer into chunks, colormap endpoints (viridis at 0 and 1, ASPRS class 6 colour), store `set/subscribe/selector`. Playwright smoke: load demo, read HUD, move budget, screenshot per colour mode and per theme.

## Docs

README: usage (`npm run data:demo`, dev), controls, `PointCloudViewer` props. ARCHITECTURE: loader, buffers and upload path, material, chunk sprites, store, theming; memory table with the main-thread CPU copy.

## Plan shape

Mergeable midpoint after loader + buffers + material + sprites + camera + HUD (demo renders progressively). Panel, colormaps, theme, keys, spike deletion follow.
