# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 0 done: spike results in docs/ARCHITECTURE.md.

## Setup
npm install
npm run dev        # Chrome with WebGPU
npm test
npm run build

`.npmrc` sets `legacy-peer-deps=true`: @react-three/fiber@9.7.0 peer range (`react >=19 <19.3`) excludes pinned react@19.3.0.

## Spike params
`?n=2000000&size=3` — point count, point size px.

## Spike results
Synthetic cloud, Apple M4 Max, Chromium 153 (headless Playwright), DPR 1, size 3 px, Sprite-quad path (4 verts/pt), `requiredLimits.maxStorageBufferBindingSize` = adapter limit. Full notes: `docs/ARCHITECTURE.md`.

| N | frame ms (default → post-orbit) | fps | tris/frame | flags compute submit / gpu ms | synthetic gen ms | GPU mem MiB (computed buffers) | GPU mem MiB (proxy: GPU-process RSS delta) |
|---|---|---|---|---|---|---|---|
| 2M | 4.82 → 6.37 | 208 → 157 | 4,000,001 | 1.50 / 0.066 | ~135 | 17.2 (pos 16M + flags 2M) | n/a |
| 10M | 25.10 → 24.68 | 40 → 41 | 20,000,001 | 0.90 / 0.262 | ~700 | 85.8 (pos 80M + flags 10M) | baseline |
| 20M | 64.94 → 65.03 | 15 → 15 | 40,000,001 | 1.10 / 0.524 | ~1340 | 171.7 (pos 160M + flags 20M) | +77.4 |

- "computed buffers" = `N×8` B positions + `ceil(N/4)×4` B flags, not measured VRAM. "RSS proxy" = Chromium GPU-process RSS before/after loading 20M (unified memory; loose upper bound).
- "submit" = CPU encode+submit of `computeAsync` (does not await GPU); "gpu" = `resolveTimestampsAsync('compute')`.
- Without `requiredLimits`, 20M compute fails (`maxStorageBufferBindingSize` default 128 MiB → max 16,777,216 pts); render unaffected.
