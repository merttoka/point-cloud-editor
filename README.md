# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 4b done: GPU normals (spatial hash, radius PCA) + tangent-plane AO, wrap + fixed-sun shading, normals debug view, CPU benchmark + verify.

2M: 240 fps (vsync) · 20M: 33.7 ms EDL off / 33.0 ms on at 100 % budget, 17.1 / 17.4 ms at 50 % — EDL cost is below the HUD's noise floor (≤ 0.5 ms) (M4 Max, Chromium, DPR 1, size 2 px). Lit / Lit + AO shading (wrap + fixed sun, `sqrt(ao)`) adds nothing measurable: 2M stays at the 4.17 ms vsync floor, 20M at 35 ms in every mode (branchless vertex-stage blend).

Compute build (radius 6 × spacing: 4.24 m demo, 1.34 m full; GPU = timestamp query per pass; CPU = same algorithms in the loader worker; the hash row is the 3× measurement — its cost depends on `T`/`N`, not radius):

| pass | GPU ms @2M | GPU ms @20M | CPU ms @2M (worker) |
|---|---|---|---|
| hash (count+scan+scatter) | 0.52 | 9.05 | 17–19 |
| normals (radius PCA) | 34–36 | 630 | 6,587–7,834 |
| ao | 46 | 685 | 6,099–6,363 |
| **total** | **80–83** | **1,321** | **13.0–14.2 s** |

Radius default 6 × spacing: at 20M density (~0.224 m spacing) a 16-neighbour cap kept the PCA support within ~0.5 m whatever the radius; radius PCA at 6× puts the class-6 facade `|n.z|` wall-bin mass at 0.109 @2M / 0.078 @20M (0.043 / 0.021 at 3×; `docs/ARCHITECTURE.md` § Normal quality).

Build wall time: 121–130 ms at 2M, 2.54 s at 20M (six `computeAsync` + timestamp resolves). Verify @2M: median 0.000°, max 81.23°, AO MAE 0.0001, non-finite 0; 2M-only by design (same point set on both sides). On the full set the CPU bench runs a 1,999,872-point per-chunk prefix subsample (hash 14–18 / normals 4,582–4,663 / ao 4,029–4,220 ms, ~8.8 s wall) — faster than the demo because the prefix is a tenth of the full density at the same 1.34 m radius, which is also why Verify can't use it.

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
`<PointCloudViewer manifestUrl="/data/demo/manifest.json" theme="dark" />` — `theme?: 'dark' | 'light'`, `className?`, `dpr?: number` (canvas pixel ratio override; default device-clamped `[1, 2]`; the dev harness's `?dpr=` clamps to `[0.5, 4]`).

## Controls
| Input | Action |
|---|---|
| drag / wheel | orbit / zoom (OrbitControls, +Z up) |
| `F` | refit camera to dataset |
| `H` | toggle HUD |
| `\` (hold) | show the key list |
| panel | point budget %, point size px, colour mode (height / intensity / class), colormap, EDL on/off, radius (1–4 px), strength (0–4), build normals + AO (radius 2–10 × spacing, default 6×), shading (flat / lit / lit + AO / normals debug), CPU benchmark, verify |
Keys work only while the viewer has focus (click it first). A centred progress card covers the load; it unmounts on ready.

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
