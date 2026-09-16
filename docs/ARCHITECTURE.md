# Architecture

## Phase 0 spike findings (three 0.186.0)

Machine: Apple M4 Max, macOS 25.6.0, Chromium 153.0.0.0 (Playwright), WebGPU adapter `apple` / `metal-3`, DPR 1, 240 Hz rAF cap (4.17 ms empty frame). Run: `?n=2000000&size=3|8`.

- Point draw mechanism: **Sprite quads** (`THREE.Sprite` + `PointsNodeMaterial`, `sizeNode` in px, `sizeAttenuation=false`); verts/point = 4 (2 tris); HUD `pts 0  tris 4000001` at 2M (the +1 is the renderer's output-quad pass, see below).
  - Primary path (`THREE.Points` + `PointsNodeMaterial.sizeNode`) rendered but check 5.3 **failed**: `?size=8` identical to `?size=3`, always 1 px. No console error; three's own docs in `PointsNodeMaterial.js` state WebGPU point-list only supports 1 px and `sizeNode` "has no effect when the material is used with Points and a WebGPU backend". HUD on that path: `draws 2  pts 2000000  tris 1`.
  - Brief's fallback used `SpriteNodeMaterial.scaleNode`; per `SpriteNodeMaterial.setupPositionView` that scale is world units × `-viewZ` when `sizeAttenuation=false` (not px). `PointsNodeMaterial` on a `Sprite` takes `setupVertexSprite`, which adds `sizeNode * DPR / (viewport/2) * clip.w` → true pixel size. Used that instead.
- Positions: `StorageInstancedBufferAttribute(Uint32Array, 2)` → `uint32x2` instanced attribute; bit-unpack in vertex (`x = w.x & 0xffff`, `y = w.x >> 16`, `z = w.y & 0xffff`, `cls = (w.y >> 24) & 0xff`). No pipeline/shader errors mentioning `qpos`, `uvec2` or `vertex buffer`.
  `uint16x3` is not a WebGPU vertex format; `uint16x4` would block compute reads (no u16 in WGSL). Words layout = disk bytes.
- Point index in vertex stage: `instanceIndex` (`storage(attr,'uvec2',n).toAttribute()` reads per-instance).
- Bounds: set `geometry.boundingBox/boundingSphere` manually. Points path: culling verified with stock `Points` (`pts 2000000 → 0`). Sprite path: `Sprite.intersectsFrustum` calls `frustum.intersectsSprite` (unit sphere at object origin, ignores geometry bounds); overriding it with `frustum.intersectsObject(sprite)` makes the manual sphere effective — verified `tris 4000001 → 1` with the cloud off-screen, back to `4000001` on return.
- `draws` never reaches 0: `WebGPURenderer` renders to an internal target and blits with a fullscreen quad (`_renderOutputLayers`), which counts as `draws 1  tris 1`. Off-screen HUD = `draws 1  pts 0  tris 1`.
- `renderer.info` counters read 0 from r3f's `useFrame` unless `info.autoReset=false` and the app resets after reading: three's internal rAF (`Animation.js`) calls `info.reset()` every tick and races r3f's loop.
- `info.render.timestamp` stays 0 unless `renderer.resolveTimestampsAsync('render')` is awaited; with that it reported 11–17 ms per resolve at 2M/size 3, but resolves span several frames so it is not a per-frame number. Wall clock is the reliable metric for now.
- 2M @ size 3: 4.9–5.7 ms / ~180–200 fps (rAF wall clock, GPU bound above the 4.17 ms vsync). 2M @ size 8: 6.6–7.3 ms / ~140–150 fps. 1 px `Points` path: 4.17 ms / 240 fps (vsync capped).
- Console: 0 errors. Warnings (benign): `THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.` (drei) and `THREE.WebGPURenderer: PCFSoftShadowMap has been removed. Using PCFShadowMap instead.` (r3f default shadow type).
- Type deviations vs brief: `Points` typings lack `count` (runtime uses `object.count` for instance count; `Sprite` has it typed). `extend(THREE as any)` and `__spike` casts as briefed. `window.__spikeCamera/__spikeControls/__spikeGl` exposed from `SpikeApp` for headless checks.
