# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 5 done: click pick + lasso select on the GPU (budget-aware), isolate / hide / delete / unhide, plane split, undo/redo ring, export zip. Phase 4b: GPU normals (spatial hash, radius PCA) + tangent-plane AO, wrap + fixed-sun shading, normals debug view, CPU benchmark + verify.

Editing at 20M (100 % budget, 1277×860, M4 Max): lasso kernel 1.0–1.2 ms GPU (0.07–0.13 ms at 2M), 20 MB flags readback 135–173 ms (4–12 ms at 2M), whole-buffer lasso wall 311–378 ms incl. undo copy + recount; pick 37–146 ms wall (mean 96; 2.1 ms at 2M — the number is queue wait behind 33 ms frames, not kernel cost); hide of 16.8M points 147 ms, delete of 2.6M 124 ms, undo/redo 41–52 ms (CPU pass + 20 MB upload + recount); split 489 ms on a 16.8M-point selection; export of 17.4M points 398 ms → 139.3 MB zip (2M: 1.04M points, 33 ms, 8.3 MB). Frame at home pose 33.2–33.3 ms with 0 or 16.8M points tinted (branchless vertex-stage blend), 19.0 ms with 16.8M hidden (collapsed quads).

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
| drag / wheel | orbit / zoom (OrbitControls, +Z up; orbit tool only) |
| click | pick the nearest rendered point under the cursor (< 4 px pointer travel) → replace selection; miss clears it |
| `⇧` click / `⌥` click | add / subtract the picked point |
| `L`, drag | lasso tool: drag a polygon on the SVG overlay (simplified at 2 px, ≤ 256 vertices), release → replace; `⇧` add, `⌥` subtract; double-click or `Esc` → orbit |
| `I` / `X` / `Delete` | isolate (hide everything else) / hide / delete the selection (or the chosen split side) |
| `U` / `C` | unhide all / clear selection |
| `S` | split: RANSAC + PCA plane through the selection, tags sides A / B (toolbar select `all / A / B` scopes the next op) |
| `⌘Z` / `⇧⌘Z` (`Ctrl` on Linux/Windows) | undo / redo |
| `F` | refit camera to dataset |
| `H` | toggle HUD |
| `\` (hold) | show the key list |
| toolbar (bottom-left) | Orbit / Lasso, Isolate, Hide, Delete, Unhide all, Clear, Split + side, Undo / Redo, Export; counts `sel · hidden · deleted`, last lasso `gpu / readback ms`, last `pick ms` |
| panel | point budget %, point size px, colour mode (height / intensity / class), colormap, EDL on/off, radius (1–4 px), strength (0–4), build normals + AO (radius 2–10 × spacing, default 6×), shading (flat / lit / lit + AO / normals debug), CPU benchmark, verify |
Keys work only while the viewer has focus (click it first) and are ignored from the panel's form controls. A centred progress card covers the load; it unmounts on ready.

### Editing
One flag byte per point (`hidden 1 · selected 2 · deleted 4 · splitA 8 · splitB 16`) lives in the 20 MB `flags` storage buffer the vertex stage already reads; a `Uint8Array` view of the same words is the CPU source of truth. Pick and lasso run as WGSL compute over the rendered prefix of every chunk (the budget slider decides what is pickable), lasso writes flags on the GPU and reads the whole buffer back into the mirror; isolate / hide / delete / split / undo mutate the mirror and upload the touched word range. Hidden and deleted points collapse to zero-size quads; selected points tint with the theme accent (`--pcv-accent`), split sides teal / orange. Undo ring: 30 commands or 256 MB of saved bytes, whichever first — a whole-buffer edit (lasso, isolate, unhide, split, hide/delete) saves N bytes, so about 12 such edits fit at 20M, 128 at 2M; picks save only the selection's index range.

### Export
Export writes `export.zip` = `manifest.json` + `points.bin` in the same v1 layout the loader reads (one chunk, deleted points dropped, hidden kept, bounds unchanged); compaction and zipping (`fflate`, stored) run in the loader worker. Re-open by unzipping into `public/data/<folder>/` and loading `http://localhost:5173/?data=<folder>` (`[a-z0-9-]+`; default `demo`) — a fresh page load, not an in-place dataset switch.

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
