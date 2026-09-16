# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 2 done: streaming viewer on the demo set.

2M: 240 fps (vsync) · 20M: 30 fps at 100% budget, 57 fps at 50% (M4 Max, Chromium, DPR 1, size 2 px).

## Setup
```bash
npm install
npm run dev        # Chrome with WebGPU
npm test
npm run build
```

`.npmrc` sets `legacy-peer-deps=true`: @react-three/fiber@9.7.0 peer range (`react >=19 <19.3`) excludes pinned react@19.3.0.

## Data

Demo (2M points, 16 MB) and full (20M, 160 MB) datasets are GitHub Release assets (`v0.1-data`):

```bash
npm run data:demo   # → public/data/demo/{manifest.json,points.bin}
npm run data:full   # → public/data/full/
```

Source: City of Vancouver LiDAR 2022, tile `491000_5458000` (downtown), UTM 10N metres, ~51 pts/m² (51.5M raw points per 1 km² tile).
Contains information licensed under the Open Government Licence – Vancouver (https://opendata.vancouver.ca/pages/licence/).
Switched from USGS 3DEP to Vancouver open data: every 3DEP candidate tile only carries baseline classes (no building/vegetation).
Release assets are served without CORS headers; the scripts download them and the viewer loads same-origin from `public/data/` (see ARCHITECTURE › Hosting).

### Rebuilding from the raw tile

```bash
python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt
tools/.venv/bin/python tools/fetch.py --list --near 491500 5458500        # tile names + URLs
# download https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip in a browser
# (the host serves a Cloudflare browser challenge to scripts)
tools/.venv/bin/python tools/fetch.py --import ~/Downloads/491000_5458000.zip --name vancouver-downtown
tools/.venv/bin/python tools/preprocess.py data/raw/vancouver-downtown.las data/processed/vancouver-downtown --stats
tools/.venv/bin/python tools/preprocess.py data/raw/vancouver-downtown.las data/processed/vancouver-downtown \
  --max-points 20000000 --demo 2000000 --cell-size 64
tools/.venv/bin/pytest tools/tests
```
Preprocess of the raw tile (51,494,885 points → 20M + 2M) takes 8.3 s on an M4 Max.

## Usage
```bash
npm run data:demo   # fetch the 2M demo set into public/data/demo/ (release asset)
npm run dev         # Chrome with WebGPU → http://localhost:5173
```
`<PointCloudViewer manifestUrl="/data/demo/manifest.json" theme="dark" />` — `theme?: 'dark' | 'light'`, `className?`.

## Controls
| Input | Action |
|---|---|
| drag / wheel | orbit / zoom (OrbitControls, +Z up) |
| `F` | refit camera to dataset |
| `H` | toggle HUD |
| panel | point budget %, point size px, colour mode (height / intensity / class), colormap |
Keys work only while the viewer has focus (click it first).

## Phase 0 spike results
Synthetic cloud, Apple M4 Max, Chromium 153 (headless Playwright), DPR 1, size 3 px, Sprite-quad path (4 verts/pt), `requiredLimits.maxStorageBufferBindingSize` = adapter limit. Full notes: `docs/ARCHITECTURE.md`.

| N | frame ms (default → post-orbit) | fps | tris/frame | flags compute submit / gpu ms | synthetic gen ms | GPU mem MiB (computed buffers) | GPU mem MiB (proxy: GPU-process RSS delta) |
|---|---|---|---|---|---|---|---|
| 2M | 4.82 → 6.37 | 208 → 157 | 4,000,001 | 1.50 / 0.066 | ~135 | 17.2 (pos 16M + flags 2M) | n/a |
| 10M | 25.10 → 24.68 | 40 → 41 | 20,000,001 | 0.90 / 0.262 | ~700 | 85.8 (pos 80M + flags 10M) | baseline |
| 20M | 64.94 → 65.03 | 15 → 15 | 40,000,001 | 1.10 / 0.524 | ~1340 | 171.7 (pos 160M + flags 20M) | +77.4 |

- "computed buffers" = `N×8` B positions + `ceil(N/4)×4` B flags, not measured VRAM. "RSS proxy" = Chromium GPU-process RSS before/after loading 20M (unified memory; loose upper bound).
- "submit" = CPU encode+submit of `computeAsync` (does not await GPU); "gpu" = `resolveTimestampsAsync('compute')`.
- Without `requiredLimits`, 20M compute fails (`maxStorageBufferBindingSize` default 128 MiB → max 16,777,216 pts); render unaffected.
