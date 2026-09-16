# Phase 1: Preprocess — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §1, §7.1 (amendments A1, A6 apply)

## Goal

Turn one USGS 3DEP LAZ tile into the v1 point format + manifest, produce a full (≤20M) and a demo (2M) dataset, publish both as GitHub Release assets, and prove HTTP Range + CORS work from a browser against those assets.

## Scope

In: `tools/` Python venv + scripts, `scripts/fetch-data.mjs`, pytest suite, release `v0.1-data`, README data section, ARCHITECTURE data-pipeline section.
Out: any viewer code, multi-tile mosaics, reprojection between CRSs, LAS 1.4 extra-bytes, colour (RGB) channels.

## Interfaces

### Layout
```
tools/
  requirements.txt     # pinned exact: laspy[lazrs], numpy, pytest
  fetch.py             # tile discovery + download
  preprocess.py        # LAZ → points.bin + manifest.json (importable functions + CLI)
  check_hosting.py     # Range + CORS probe
  tests/test_preprocess.py
scripts/
  fetch-data.mjs       # node, zero deps: release assets → public/data/<name>/
data/raw/              # gitignored
data/processed/        # gitignored
public/data/           # gitignored
```
Venv: `python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt` (`.venv` gitignored).

### `fetch.py`
```
fetch.py --bbox W S E N [--limit 20]   # list LPC products: project, title, MB, URL, date
fetch.py --url URL                     # stream to data/raw/<basename>; write <basename>.source.json
```
- Discovery: `GET https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Lidar%20Point%20Cloud%20(LPC)&bbox=W,S,E,N&prodFormats=LAZ&max=<limit>`; print `items[].{title, sourceId, sizeInBytes, publicationDate, downloadURL}`.
- Download: `urllib`, streamed, progress on stderr. `source.json` = `{ url, title, sourceId, fetched (ISO), license: "USGS 3DEP, public domain" }`.
- Candidate bboxes (WGS84 lon/lat), tried in the spec's priority order until `--stats` passes the vetting rule:
  - LA downtown `-118.26 34.04 -118.24 34.06`
  - Santa Barbara `-119.71 34.41 -119.69 34.43`
  - San Francisco `-122.42 37.78 -122.40 37.80`
  - NYC `-74.01 40.70 -73.99 40.72`
- Vetting rule: class 6 (Building) ≥ 3% and class 5 (High Vegetation) ≥ 3% of points, raw count ≥ 5M.

### `preprocess.py`
```
preprocess.py IN.laz OUT_DIR [--max-points N] [--cell-size M] [--demo N] [--units auto|m|ft|ftus] [--z-units auto|m|ft|ftus] [--seed 1] [--stats]
```
Pipeline (all coordinates converted to metres first):
1. Read with laspy (lazrs backend). Linear units, horizontal and vertical resolved **separately** (State Plane ftUS horizontal with NAVD88 metres vertical exists in 3DEP): `--units auto` / `--z-units auto` look first for a WKT VLR (`WktCoordinateSystemVlr.string`, LAS 1.4 point formats 6–10 always carry one): horizontal from the `PROJCS`/`PROJCRS` `UNIT`, vertical from the `VERT_CS`/`VERTCRS` `UNIT`; string match `US survey foot` / `Foot_US` / `ftUS` → 1200/3937 m, `foot` / `Foot` → 0.3048 m, `metre` / `meter` → 1. If no WKT VLR (LAS 1.2/1.3 tiles carry GeoTIFF keys instead), read `GeoKeyDirectoryVlr.geo_keys`: key 3076 `ProjLinearUnitsGeoKey` (horizontal) and key 4099 `VerticalUnitsGeoKey` (vertical), values 9001 metre / 9002 international foot / 9003 US survey foot. Neither found → error unless `--units`/`--z-units` given explicitly; `--stats` reports which source was used. No pyproj. `--stats`: print count, bounds (native + metres), unit source, ASPRS class histogram with names, intensity p1/p50/p99, then exit.
2. `--max-points N`: seeded random permutation, keep first N (uniform subsample).
3. Global AABB (metres) → u16 quantization `q = round((p - min) / (max - min) * 65535)`, clamped. Degenerate axis → 0.
4. Intensity u16 → u8 by p1–p99 normalisation, clamped; `p99 == p1` (tiles with no intensity) → all 0. Classification u8 raw.
5. Chunking: 2D XY grid, cell `--cell-size` metres (default 64), cell `(ix, iy) = floor((xy - min) / cell)`; chunk order row-major `(iy, ix)`; empty cells omitted. Within each chunk a seeded shuffle, so any prefix is a uniform subsample of that chunk.
6. Write `points.bin` (interleaved `[u16 x][u16 y][u16 z][u16 packed]`, little-endian) and `manifest.json` (below). `bytesPerPoint` fixed at 8.
7. `--demo N`: take the first N of a seeded global permutation of the already-quantized points, keep the **same bounds** (no re-quantization), re-chunk, write to `OUT_DIR/demo/`.

Memory: float64 XYZ until quantized; ~1 GB peak at 20M. Target: 20M in under 2 minutes on the M4 Max (report actual in README).

### `manifest.json`
```json
{ "version": 1, "name": "la-downtown", "source": "<tile URL>", "license": "USGS 3DEP, public domain",
  "crs": "<WKT or EPSG string from VLR>", "units": "m",
  "bounds": {"min":[x,y,z],"max":[x,y,z]},
  "pointCount": N, "bytesPerPoint": 8, "file": "points.bin",
  "classMap": {"2":"Ground","5":"High Vegetation","6":"Building"},
  "chunks": [{ "offset": 0, "count": n, "bounds": {"min":[..],"max":[..]} }] }
```
`classMap` lists only classes present. `chunks[i].offset` is in points; `offset_{i+1} = offset_i + count_i`. Chunk bounds are tight AABBs in metres. `file` is resolved relative to the manifest URL.

### `check_hosting.py URL`
Follows redirects manually (hop by hop, `Origin: https://example.com` on every request), then reports PASS/FAIL for: `GET Range: bytes=0-15` on the final URL → `206`, `Content-Range: bytes 0-15/<size>`, body length 16 (authoritative Range check; `Accept-Ranges: bytes` on HEAD is printed as informational only, CDNs often omit it on HEAD); `access-control-allow-origin: *` (or the echoed origin) on **every** hop including each `302`, since the browser applies the CORS check to redirect responses too, not only to the final one. Prints the redirect chain and the final resolved URL. Non-zero exit on any FAIL.

### `scripts/fetch-data.mjs`
`npm run data:demo` / `npm run data:full`. Downloads `https://github.com/merttoka/point-cloud-editor/releases/download/v0.1-data/<name>-manifest.json` and `<name>-points.bin` into `public/data/<name>/{manifest.json,points.bin}`; skips files whose size already matches `Content-Length`. Release assets are flat, hence the `<name>-` prefix; the script renames on write.

### Release `v0.1-data`
`gh release create v0.1-data` with four assets (`demo-manifest.json`, `demo-points.bin`, `full-manifest.json`, `full-points.bin`). Notes: source tile URL, project name, licence, point counts, preprocess flags used. Data releases are tagged independently of code.

## Acceptance criteria

- Chosen tile passes the vetting rule via `--stats`.
- Full dataset ≤ 20M points; `points.bin` size = `pointCount × 8`; chunk counts sum to `pointCount`; offsets contiguous and ascending.
- Demo dataset exactly 2M points, same `bounds` as full.
- `check_hosting.py` passes on both bins from the release.
- On a clean clone, `npm install && npm run data:demo` populates `public/data/demo/`.
- pytest green. Preprocess wall time recorded in README.

## Risks and spikes

- **TNM Access API unavailable or schema changed** → `--url` manual path; README lists the staged LPC URL pattern.
- **No LA tile with both classes** → walk the bbox list; the manifest `name` follows the chosen city.
- **Release asset redirect loses CORS or Range** (assets redirect to `objects.githubusercontent.com`) → decide at that point between website static hosting (`git-ftp`) and keeping the release; the loader's full-fetch fallback covers a missing Range but not missing CORS.
- **LAZ decode speed** at 30M+ raw points: lazrs is multi-threaded, expect ~30 s; acceptable.

## Tests (pytest, `tools/tests/test_preprocess.py`)

Fixture: synthetic LAS written with laspy (seeded random points, classes 2/5/6 in known proportions, u16 intensities; 200k points on a 2×2 cell grid so every chunk holds ~50k points; variants: US-survey-foot WKT VLR, GeoTIFF-key-only with 3076 = 9003 and 4099 = 9001 (ftUS horizontal, metre vertical), no CRS at all).
- quantization error ≤ half a step per axis after dequantization
- chunk counts sum to N; offsets contiguous, ascending; row-major cell order
- manifest keys and types; `classMap` only present classes; `units == "m"`
- feet variant: bounds converted to metres; GeoTIFF variant: XY scaled by 1200/3937, Z unscaled; no-CRS variant errors without `--units`
- `--stats` prints the histogram and exits without writing files
- zero-intensity fixture → all intensities 0, no division warning
- shuffle-prefix uniformity: first 10% of each chunk (≥ 5k points) has class proportions within ±3 pp of the chunk's (≈ 4σ at p = 0.5 for a 5k hypergeometric sample; ±2 pp on small chunks fails by chance)
- `--demo` count and identical `bounds`
- `--max-points` count
- byte layout of point 0 equals `[x, y, z, intensity | class << 8]` as u16 little-endian

## Docs

README: data section (venv setup, fetch, preprocess, `npm run data:demo`, source + licence, timing). ARCHITECTURE: data pipeline (format, manifest, chunk order, shuffle rationale, hosting).
