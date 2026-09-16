# Phase 1: Preprocess — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one City of Vancouver LiDAR 2022 tile into the v1 point format (`points.bin` + `manifest.json`) as a 20M full set and a 2M demo, publish both as GitHub Release assets, and prove HTTP Range + CORS work against them.

**Architecture:** A Python venv under `tools/` holds three scripts: `fetch.py` (tile discovery via the open-data API, zip import), `preprocess.py` (LAS/LAZ → metres → u16 quantization → XY-grid chunks with per-chunk shuffle → `points.bin` + manifest; importable functions + CLI), `check_hosting.py` (redirect-aware Range + CORS probe). A zero-dependency node script pulls release assets into the gitignored `public/data/`. Tests are pytest over synthetic LAS files written with laspy.

**Tech Stack:** Python 3.14 venv, `laspy==2.7.0` with `lazrs==0.8.2`, `numpy==2.5.3`, `pytest==9.1.1`; node ≥ 18 (`fetch`, `stream/promises`); `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-1-preprocess-design.md` (parent: `2026-09-15-point-cloud-editor-design.md`, amendments A1, A6, A10)

## Global Constraints

- Point byte format v1: `[u16 x][u16 y][u16 z][u16 packed = intensity | (class << 8)]`, little-endian, 8 B/pt. `bytesPerPoint` fixed at 8.
- Manifest `version: 1`, `units: "m"` always; bounds and chunk bounds in metres; `chunks[i].offset` in points, contiguous and ascending; `classMap` only present classes.
- Data source: City of Vancouver LiDAR 2022 (A10), tile `491000_5458000`, licence "Open Government Licence – Vancouver" with the attribution line in README and release notes. Raw LAS/LAZ/zip never committed (`data/` gitignored). `public/data/` gitignored (A1).
- Python deps: `laspy[lazrs]`, `numpy`, `pytest` only, pinned exact in `tools/requirements.txt`. No pyproj.
- Repo public, MIT. Branch `phase-1-preprocess`, merge to main. Commit messages concise, no attribution lines.
- `README.md` updated before the merge push; `docs/ARCHITECTURE.md` gains the data-pipeline section.
- Browser steps use the Chrome MCP tools in-session; no human in the loop except where this plan says "by hand".

---

### Task 1: Branch, venv, gitignore, format helpers

**Files:**
- Create: `tools/requirements.txt`, `tools/preprocess.py`, `tools/tests/conftest.py`, `tools/tests/test_preprocess.py`, `tools/pytest.ini`
- Modify: `.gitignore`

**Interfaces:**
- Produces (`tools/preprocess.py`): `QMAX = 65535`, `FT_US = 1200 / 3937`, `FT_INTL = 0.3048`, `class_name(code: int) -> str`, `quantize_cloud(xyz: np.ndarray) -> tuple[np.ndarray, dict]` (`(N,3) uint16`, `{"min": [..], "max": [..]}`), `normalize_intensity(i: np.ndarray) -> np.ndarray` (uint8), `pack_attr(intensity8: np.ndarray, cls: np.ndarray) -> np.ndarray` (uint16).
- Produces (`tools/tests/conftest.py`): fixture `synthetic_las(tmp_path_factory)` → `dict[str, Path]` with keys `wkt_ftus`, `geokeys`, `none`, `zero_intensity`; each file has 200k points on a 2×2 grid of 64 m cells, classes 2/5/6 at 60/25/15 %, seed 7.

- [ ] **Step 1: Branch, venv, gitignore**

```bash
cd ~/Developer/Graphics/TS_PointCloud
git checkout -b phase-1-preprocess
python3 -m venv tools/.venv
tools/.venv/bin/pip install "laspy[lazrs]==2.7.0" numpy==2.5.3 pytest==9.1.1
tools/.venv/bin/pip freeze | grep -iE "^(laspy|lazrs|numpy|pytest)=" > tools/requirements.txt
cat tools/requirements.txt
```
Expected: four pinned lines (`laspy==2.7.0`, `lazrs==0.8.2`, `numpy==2.5.3`, `pytest==9.1.1`). Note: `pip freeze` prints `laspy==2.7.0` without the extra; keep it that way and install with `pip install -r tools/requirements.txt` (lazrs is pinned on its own line).

`.gitignore` (replace the `data/raw` line, add the rest):
```
node_modules
dist
data/
public/data/
tools/.venv/
__pycache__/
.pytest_cache/
.DS_Store
*.local
.playwright-mcp/
.superpowers/
```

`tools/pytest.ini`:
```ini
[pytest]
testpaths = tests
```

- [ ] **Step 2: Failing tests for the pure helpers**

`tools/tests/conftest.py`:
```python
import sys
from pathlib import Path

import laspy
import numpy as np
import pytest
from laspy.vlrs.known import GeoKeyDirectoryVlr, GeoKeyEntryStruct, WktCoordinateSystemVlr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # tools/ on the path

WKT_FTUS = (
    'COMPD_CS["NAD83 / California zone 5 (ftUS) + NAVD88 height (ftUS)",'
    'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",'
    'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],'
    'PROJECTION["Lambert_Conformal_Conic_2SP"],UNIT["US survey foot",0.304800609601219]],'
    'VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],'
    'UNIT["US survey foot",0.304800609601219],AXIS["Up",UP]]]'
)

N = 200_000
CELL = 64.0


def _geokey(key_id: int, value: int) -> GeoKeyEntryStruct:
    k = GeoKeyEntryStruct()
    k.id, k.tiff_tag_location, k.count, k.value_offset = key_id, 0, 1, value
    return k


def write_synthetic(path: Path, crs: str, zero_intensity: bool = False, seed: int = 7) -> Path:
    rng = np.random.default_rng(seed)
    if crs == "wkt_ftus":
        header = laspy.LasHeader(point_format=6, version="1.4")
        header.vlrs.append(WktCoordinateSystemVlr(WKT_FTUS))
    else:
        header = laspy.LasHeader(point_format=1, version="1.2")
        if crs == "geokeys":
            g = GeoKeyDirectoryVlr()
            g.geo_keys = [_geokey(1024, 1), _geokey(3076, 9003), _geokey(4099, 9001)]
            header.vlrs.append(g)
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.zeros(3)
    las = laspy.LasData(header)
    las.x = rng.uniform(0, 2 * CELL, N)
    las.y = rng.uniform(0, 2 * CELL, N)
    las.z = rng.uniform(0, 50, N)
    las.intensity = (np.zeros(N, np.uint16) if zero_intensity
                     else rng.integers(0, 65535, N, dtype=np.uint16))
    las.classification = rng.choice(np.array([2, 5, 6], np.uint8), N, p=[0.60, 0.25, 0.15])
    las.write(path)
    return path


@pytest.fixture(scope="session")
def synthetic_las(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("las")
    return {
        "wkt_ftus": write_synthetic(d / "ftus.laz", "wkt_ftus"),
        "geokeys": write_synthetic(d / "geokeys.las", "geokeys"),
        "none": write_synthetic(d / "none.las", "none"),
        "zero_intensity": write_synthetic(d / "zero.las", "none", zero_intensity=True),
    }
```

`tools/tests/test_preprocess.py`:
```python
import numpy as np

from preprocess import QMAX, class_name, normalize_intensity, pack_attr, quantize_cloud


def test_quantize_round_trips_within_half_step():
    rng = np.random.default_rng(1)
    xyz = rng.uniform([-100, 0, 5], [900, 1000, 305], (10_000, 3))
    q, b = quantize_cloud(xyz)
    assert q.dtype == np.uint16 and q.shape == xyz.shape
    mn, mx = np.array(b["min"]), np.array(b["max"])
    step = (mx - mn) / QMAX
    back = mn + q / QMAX * (mx - mn)
    assert np.all(np.abs(back - xyz) <= step / 2 + 1e-9)


def test_quantize_degenerate_axis_is_zero():
    xyz = np.column_stack([np.arange(10.0), np.arange(10.0), np.full(10, 3.0)])
    q, b = quantize_cloud(xyz)
    assert np.all(q[:, 2] == 0) and b["min"][2] == b["max"][2] == 3.0


def test_normalize_intensity_p1_p99():
    i = np.arange(0, 10_000, dtype=np.uint16)
    out = normalize_intensity(i)
    assert out.dtype == np.uint8 and out.min() == 0 and out.max() == 255
    assert out[5000] in (127, 128)


def test_normalize_intensity_all_zero():
    assert np.all(normalize_intensity(np.zeros(100, np.uint16)) == 0)


def test_pack_attr_layout():
    p = pack_attr(np.array([7], np.uint8), np.array([6], np.uint8))
    assert p.dtype == np.uint16 and int(p[0]) == (7 | (6 << 8))


def test_class_name_table_and_fallback():
    assert class_name(2) == "Ground" and class_name(6) == "Building"
    assert class_name(42) == "Class 42"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `ImportError` / `ModuleNotFoundError: No module named 'preprocess'`.

- [ ] **Step 4: Implement the helpers**

`tools/preprocess.py` (initial content; later tasks append to it):
```python
#!/usr/bin/env python3
"""LAS/LAZ → v1 point format: points.bin (8 B/pt, u16 LE) + manifest.json."""
from __future__ import annotations

import numpy as np

QMAX = 65535
FT_US = 1200 / 3937
FT_INTL = 0.3048

ASPRS = {
    0: "Never Classified", 1: "Unclassified", 2: "Ground", 3: "Low Vegetation",
    4: "Medium Vegetation", 5: "High Vegetation", 6: "Building", 7: "Low Point (Noise)",
    9: "Water", 10: "Rail", 11: "Road Surface", 13: "Wire - Guard", 14: "Wire - Conductor",
    15: "Transmission Tower", 16: "Wire-Structure Connector", 17: "Bridge Deck", 18: "High Noise",
}


def class_name(code: int) -> str:
    return ASPRS.get(int(code), f"Class {int(code)}")


def quantize_cloud(xyz: np.ndarray) -> tuple[np.ndarray, dict]:
    mn = xyz.min(axis=0)
    mx = xyz.max(axis=0)
    span = mx - mn
    q = np.zeros(xyz.shape, np.uint16)
    for a in range(3):
        if span[a] > 0:
            q[:, a] = np.clip(np.rint((xyz[:, a] - mn[a]) / span[a] * QMAX), 0, QMAX).astype(np.uint16)
    return q, {"min": mn.tolist(), "max": mx.tolist()}


def normalize_intensity(i: np.ndarray) -> np.ndarray:
    p1, p99 = np.percentile(i, [1, 99])
    if p99 <= p1:
        return np.zeros(i.shape, np.uint8)
    return np.clip(np.rint((i.astype(np.float64) - p1) / (p99 - p1) * 255), 0, 255).astype(np.uint8)


def pack_attr(intensity8: np.ndarray, cls: np.ndarray) -> np.ndarray:
    return (intensity8.astype(np.uint16) | (cls.astype(np.uint16) << 8)).astype(np.uint16)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `6 passed`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore tools/requirements.txt tools/pytest.ini tools/preprocess.py tools/tests
git commit -m "phase 1: tools venv, format helpers, synthetic LAS fixture"
```

---

### Task 2: Unit resolution (WKT, GeoTIFF keys, explicit)

**Files:**
- Modify: `tools/preprocess.py`
- Test: `tools/tests/test_preprocess.py`

**Interfaces:**
- Produces: `Units` dataclass `(xy: float, z: float, source: str)`; `units_from_wkt(wkt: str) -> tuple[float | None, float | None]`; `units_from_geokeys(vlr) -> tuple[float | None, float | None]`; `resolve_units(header, units="auto", z_units="auto") -> Units` (raises `ValueError` when nothing is found and no explicit unit is given); `crs_string(header) -> str`.

- [ ] **Step 1: Failing tests**

Append to `tools/tests/test_preprocess.py`:
```python
import laspy
import pytest

from conftest import WKT_FTUS
from preprocess import FT_US, crs_string, resolve_units, units_from_wkt


def test_units_from_wkt_compound_ftus():
    assert units_from_wkt(WKT_FTUS) == (FT_US, FT_US)


def test_units_from_wkt_projcs_metres_no_vertical():
    wkt = 'PROJCS["UTM 10N",GEOGCS["NAD83",UNIT["degree",0.0174532925199433]],UNIT["metre",1]]'
    assert units_from_wkt(wkt) == (1.0, None)


def test_units_from_wkt2_lengthunit():
    wkt = ('PROJCRS["x",BASEGEOGCRS["NAD83",ANGLEUNIT["degree",0.0174532925199433]],'
           'CS[Cartesian,2],AXIS["(E)",east,LENGTHUNIT["metre",1]],AXIS["(N)",north,LENGTHUNIT["metre",1]]]')
    assert units_from_wkt(wkt) == (1.0, None)


def test_resolve_units_wkt(synthetic_las):
    u = resolve_units(laspy.read(synthetic_las["wkt_ftus"]).header)
    assert (u.xy, u.z, u.source) == (FT_US, FT_US, "wkt")


def test_resolve_units_geokeys(synthetic_las):
    u = resolve_units(laspy.read(synthetic_las["geokeys"]).header)
    assert (u.xy, u.z, u.source) == (FT_US, 1.0, "geokeys")


def test_resolve_units_none_errors_without_override(synthetic_las):
    h = laspy.read(synthetic_las["none"]).header
    with pytest.raises(ValueError):
        resolve_units(h)
    u = resolve_units(h, units="m", z_units="m")
    assert (u.xy, u.z, u.source) == (1.0, 1.0, "explicit")


def test_resolve_units_partial_override_wins(synthetic_las):
    u = resolve_units(laspy.read(synthetic_las["wkt_ftus"]).header, z_units="m")
    assert (u.xy, u.z) == (FT_US, 1.0)


def test_crs_string(synthetic_las):
    assert crs_string(laspy.read(synthetic_las["wkt_ftus"]).header).startswith("COMPD_CS[")
    assert crs_string(laspy.read(synthetic_las["geokeys"]).header) == "geokeys:ProjectedCSTypeGeoKey=none"
    assert crs_string(laspy.read(synthetic_las["none"]).header) == "unknown"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/.venv/bin/pytest tools/tests -q -k units`
Expected: `ImportError: cannot import name 'resolve_units'`.

- [ ] **Step 3: Implement**

Append to `tools/preprocess.py` (add `import re` and `from dataclasses import dataclass` at the top, plus `from laspy.vlrs.known import GeoKeyDirectoryVlr, WktCoordinateSystemVlr`):
```python
_UNIT_RE = re.compile(r'(?:LENGTH)?UNIT\["([^"]+)"')
_VERT_RE = re.compile(r"VERT_?CS\[|VERTCRS\[")
GEOTIFF_UNITS = {9001: 1.0, 9002: FT_INTL, 9003: FT_US}
EXPLICIT_UNITS = {"m": 1.0, "ft": FT_INTL, "ftus": FT_US}


@dataclass
class Units:
    xy: float
    z: float
    source: str


def unit_factor(name: str) -> float | None:
    n = name.lower()
    if "survey" in n or "ftus" in n or "foot_us" in n or "us foot" in n:
        return FT_US
    if "foot" in n or "feet" in n:
        return FT_INTL
    if "met" in n:
        return 1.0
    return None


def units_from_wkt(wkt: str) -> tuple[float | None, float | None]:
    vert = _VERT_RE.search(wkt)
    horiz = wkt[: vert.start()] if vert else wkt
    h_names = _UNIT_RE.findall(horiz)
    # The last UNIT before VERT_CS is the projected linear unit (GEOGCS's degree comes earlier).
    h = unit_factor(h_names[-1]) if h_names else None
    v = None
    if vert:
        v_names = _UNIT_RE.findall(wkt[vert.start():])
        v = unit_factor(v_names[0]) if v_names else None
    return h, v


def units_from_geokeys(vlr) -> tuple[float | None, float | None]:
    h = v = None
    for k in vlr.geo_keys:
        if k.id == 3076:
            h = GEOTIFF_UNITS.get(int(k.value_offset))
        elif k.id == 4099:
            v = GEOTIFF_UNITS.get(int(k.value_offset))
    return h, v


def _crs_vlrs(header):
    wkt = geo = None
    for vlr in list(header.vlrs) + list(header.evlrs or []):
        if wkt is None and isinstance(vlr, WktCoordinateSystemVlr):
            wkt = vlr.string
        elif geo is None and isinstance(vlr, GeoKeyDirectoryVlr):
            geo = vlr
    return wkt, geo


def resolve_units(header, units: str = "auto", z_units: str = "auto") -> Units:
    h = EXPLICIT_UNITS.get(units)
    v = EXPLICIT_UNITS.get(z_units)
    if h is not None and v is not None:
        return Units(h, v, "explicit")
    wkt, geo = _crs_vlrs(header)
    if wkt:
        ah, av = units_from_wkt(wkt)
        source = "wkt"
    elif geo:
        ah, av = units_from_geokeys(geo)
        source = "geokeys"
    else:
        ah = av = None
        source = "none"
    if h is None:
        h = ah
    if v is None:
        v = av if av is not None else ah
    if h is None or v is None:
        raise ValueError("no linear unit found in the LAS header; pass --units / --z-units")
    return Units(h, v, source)


def crs_string(header) -> str:
    wkt, geo = _crs_vlrs(header)
    if wkt:
        return wkt
    if geo:
        for k in geo.geo_keys:
            if k.id == 3072:
                return f"geokeys:ProjectedCSTypeGeoKey=EPSG:{int(k.value_offset)}"
        return "geokeys:ProjectedCSTypeGeoKey=none"
    return "unknown"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `14 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/preprocess.py tools/tests/test_preprocess.py
git commit -m "preprocess: resolve horizontal/vertical units from WKT, GeoTIFF keys, or flags"
```

---

### Task 3: Load, subsample, chunk, write

**Files:**
- Modify: `tools/preprocess.py`
- Test: `tools/tests/test_preprocess.py`

**Interfaces:**
- Produces: `Cloud` dataclass `(xyz: np.ndarray float64 (N,3) metres, intensity: np.ndarray uint16, cls: np.ndarray uint8, crs: str, units: Units)`; `load_cloud(path, units="auto", z_units="auto") -> Cloud`; `subsample(cloud, max_points: int, seed: int) -> Cloud`; `Chunk` dataclass `(offset: int, count: int, bounds: dict)`; `chunk_order(xyz, bounds_min, cell: float, seed: int) -> tuple[np.ndarray, list[Chunk]]` (permutation of point indices, chunks in that order); `write_dataset(out_dir: Path, xyz, q, packed, cls, bounds: dict, cell: float, seed: int, meta: dict) -> dict` (returns the manifest). `meta` keys: `name`, `source`, `license`, `crs`.

- [ ] **Step 1: Failing tests**

Append to `tools/tests/test_preprocess.py`:
```python
import json
from pathlib import Path

from conftest import CELL, N
from preprocess import chunk_order, load_cloud, normalize_intensity, pack_attr, quantize_cloud, subsample, write_dataset


def _build(synthetic_las, tmp_path: Path, key="wkt_ftus", cell=CELL, seed=1):
    if key in ("none", "zero_intensity"):        # these fixtures carry no CRS
        cloud = load_cloud(synthetic_las[key], units="m", z_units="m")
    else:
        cloud = load_cloud(synthetic_las[key])
    q, bounds = quantize_cloud(cloud.xyz)
    packed = pack_attr(normalize_intensity(cloud.intensity), cloud.cls)
    meta = {"name": "t", "source": "s", "license": "l", "crs": cloud.crs}
    out = tmp_path / "out"
    m = write_dataset(out, cloud.xyz, q, packed, cloud.cls, bounds, cell, seed, meta)
    return cloud, q, packed, out, m


def test_load_cloud_converts_feet_to_metres(synthetic_las):
    ftus = load_cloud(synthetic_las["wkt_ftus"])
    raw = laspy.read(synthetic_las["wkt_ftus"])
    assert np.allclose(ftus.xyz[:, 0], raw.x * FT_US)
    assert np.allclose(ftus.xyz[:, 2], raw.z * FT_US)
    geo = load_cloud(synthetic_las["geokeys"])
    raw2 = laspy.read(synthetic_las["geokeys"])
    assert np.allclose(geo.xyz[:, 0], raw2.x * FT_US) and np.allclose(geo.xyz[:, 2], raw2.z)


def test_subsample_is_uniform_and_seeded(synthetic_las):
    c = load_cloud(synthetic_las["none"], units="m", z_units="m")
    a, b = subsample(c, 50_000, 3), subsample(c, 50_000, 3)
    assert len(a.xyz) == 50_000 and np.array_equal(a.xyz, b.xyz)
    frac = np.mean(a.cls == 6)
    assert abs(frac - 0.15) < 0.01


def test_chunk_order_row_major_contiguous():
    rng = np.random.default_rng(0)
    xyz = rng.uniform(0, 3 * CELL, (30_000, 3))
    order, chunks = chunk_order(xyz, xyz.min(axis=0), CELL, 1)
    assert sorted(order.tolist()) == list(range(30_000))
    assert sum(c.count for c in chunks) == 30_000
    off = 0
    prev_key = -1
    for c in chunks:
        assert c.offset == off
        off += c.count
        sl = xyz[order[c.offset:c.offset + c.count]]
        ix, iy = int(sl[0, 0] // CELL), int(sl[0, 1] // CELL)
        assert np.all((sl[:, 0] // CELL) == ix) and np.all((sl[:, 1] // CELL) == iy)
        key = iy * 3 + ix
        assert key > prev_key
        prev_key = key
        assert c.bounds["min"] == sl.min(axis=0).tolist() and c.bounds["max"] == sl.max(axis=0).tolist()


def test_write_dataset_layout_and_manifest(synthetic_las, tmp_path):
    cloud, q, packed, out, m = _build(synthetic_las, tmp_path)
    data = np.fromfile(out / "points.bin", dtype="<u2").reshape(-1, 4)
    assert data.shape[0] == N and (out / "points.bin").stat().st_size == N * 8
    with open(out / "manifest.json") as f:
        assert json.load(f) == m
    assert m["version"] == 1 and m["units"] == "m" and m["bytesPerPoint"] == 8 and m["file"] == "points.bin"
    assert m["pointCount"] == N and sum(c["count"] for c in m["chunks"]) == N
    offs = [c["offset"] for c in m["chunks"]]
    assert offs == sorted(offs) and offs[0] == 0
    assert m["classMap"] == {"2": "Ground", "5": "High Vegetation", "6": "Building"}
    assert len(m["chunks"]) == 4
    # point 0 of the file is the first point of chunk 0 in the shuffled order
    first = m["chunks"][0]
    w = data[0]
    assert (w[3] >> 8) in (2, 5, 6) and int(w[0]) <= QMAX
    assert first["count"] > 5_000


def test_shuffle_prefix_is_uniform(synthetic_las, tmp_path):
    cloud, q, packed, out, m = _build(synthetic_las, tmp_path)
    data = np.fromfile(out / "points.bin", dtype="<u2").reshape(-1, 4)
    cls = (data[:, 3] >> 8).astype(np.uint8)
    for c in m["chunks"]:
        full = cls[c["offset"]:c["offset"] + c["count"]]
        head = full[: max(1, c["count"] // 10)]
        for k in (2, 5, 6):
            assert abs(np.mean(head == k) - np.mean(full == k)) < 0.03


def test_zero_intensity_fixture(synthetic_las, tmp_path):
    cloud, q, packed, out, m = _build(synthetic_las, tmp_path, key="zero_intensity")
    data = np.fromfile(out / "points.bin", dtype="<u2").reshape(-1, 4)
    assert np.all((data[:, 3] & 0xFF) == 0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/.venv/bin/pytest tools/tests -q -k "load or subsample or chunk or write or shuffle or zero"`
Expected: `ImportError: cannot import name 'chunk_order'`.

- [ ] **Step 3: Implement**

Append to `tools/preprocess.py` (add `import json`, `from pathlib import Path`, `import laspy` at the top):
```python
@dataclass
class Cloud:
    xyz: np.ndarray
    intensity: np.ndarray
    cls: np.ndarray
    crs: str
    units: Units


def load_cloud(path, units: str = "auto", z_units: str = "auto") -> Cloud:
    las = laspy.read(str(path))
    u = resolve_units(las.header, units, z_units)
    n = len(las.points)
    xyz = np.empty((n, 3), np.float64)
    xyz[:, 0] = las.x * u.xy
    xyz[:, 1] = las.y * u.xy
    xyz[:, 2] = las.z * u.z
    return Cloud(xyz, np.asarray(las.intensity, np.uint16), np.asarray(las.classification, np.uint8),
                 crs_string(las.header), u)


def subsample(cloud: Cloud, max_points: int, seed: int) -> Cloud:
    n = len(cloud.xyz)
    if n <= max_points:
        return cloud
    idx = np.random.default_rng(seed).permutation(n)[:max_points]
    return Cloud(cloud.xyz[idx], cloud.intensity[idx], cloud.cls[idx], cloud.crs, cloud.units)


@dataclass
class Chunk:
    offset: int
    count: int
    bounds: dict


def chunk_order(xyz: np.ndarray, bounds_min, cell: float, seed: int) -> tuple[np.ndarray, list[Chunk]]:
    mn = np.asarray(bounds_min, np.float64)
    ix = np.floor((xyz[:, 0] - mn[0]) / cell).astype(np.int64)
    iy = np.floor((xyz[:, 1] - mn[1]) / cell).astype(np.int64)
    nx = int(ix.max()) + 1
    key = iy * nx + ix
    order = np.argsort(key, kind="stable")
    sorted_keys = key[order]
    starts = np.concatenate([[0], np.flatnonzero(np.diff(sorted_keys)) + 1, [len(order)]])
    rng = np.random.default_rng(seed)
    chunks: list[Chunk] = []
    for s, e in zip(starts[:-1], starts[1:]):
        seg = order[s:e]
        rng.shuffle(seg)          # in place: any prefix of the chunk is a uniform subsample
        pts = xyz[seg]
        chunks.append(Chunk(int(s), int(e - s), {"min": pts.min(axis=0).tolist(), "max": pts.max(axis=0).tolist()}))
    return order, chunks


def write_dataset(out_dir: Path, xyz, q, packed, cls, bounds: dict, cell: float, seed: int, meta: dict) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    order, chunks = chunk_order(xyz, bounds["min"], cell, seed)
    rec = np.empty((len(order), 4), np.uint16)
    rec[:, :3] = q[order]
    rec[:, 3] = packed[order]
    rec.astype("<u2").tofile(out_dir / "points.bin")
    present = np.unique(cls)
    manifest = {
        "version": 1,
        "name": meta["name"], "source": meta["source"], "license": meta["license"],
        "crs": meta["crs"], "units": "m",
        "bounds": bounds,
        "pointCount": int(len(order)), "bytesPerPoint": 8, "file": "points.bin",
        "classMap": {str(int(c)): class_name(int(c)) for c in present},
        "chunks": [{"offset": c.offset, "count": c.count, "bounds": c.bounds} for c in chunks],
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    return manifest
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `20 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/preprocess.py tools/tests/test_preprocess.py
git commit -m "preprocess: load in metres, subsample, row-major chunks with per-chunk shuffle, bin + manifest"
```

---

### Task 4: CLI: `--stats`, `--demo`, `--max-points`, source metadata

**Files:**
- Modify: `tools/preprocess.py`
- Test: `tools/tests/test_preprocess.py`

**Interfaces:**
- Produces: `stats(cloud: Cloud) -> dict` (`count`, `bounds`, `unitSource`, `classes: {code: {name, count, pct}}`, `intensity: {p1, p50, p99}`), `format_stats(s: dict) -> str`, `main(argv: list[str] | None = None) -> int`.
- CLI: `preprocess.py IN OUT_DIR [--max-points N] [--cell-size M] [--demo N] [--units auto|m|ft|ftus] [--z-units auto|m|ft|ftus] [--seed 1] [--name NAME] [--source URL] [--license TEXT] [--stats]`. `--name/--source/--license` default from `<IN stem>.source.json` next to the input when present, else `IN` stem, `""`, `""`.

- [ ] **Step 1: Failing tests**

Append to `tools/tests/test_preprocess.py`:
```python
from preprocess import main, stats


def test_stats_histogram(synthetic_las):
    s = stats(load_cloud(synthetic_las["wkt_ftus"]))
    assert s["count"] == N and s["unitSource"] == "wkt"
    assert set(s["classes"]) == {2, 5, 6}
    assert abs(s["classes"][6]["pct"] - 15.0) < 1.0
    assert s["classes"][6]["name"] == "Building"
    assert s["intensity"]["p99"] > s["intensity"]["p1"]


def test_cli_stats_writes_nothing(synthetic_las, tmp_path, capsys):
    rc = main([str(synthetic_las["wkt_ftus"]), str(tmp_path / "o"), "--stats"])
    out = capsys.readouterr().out
    assert rc == 0 and "Building" in out and "unit source: wkt" in out
    assert not (tmp_path / "o").exists()


def test_cli_max_points_and_demo_same_bounds(synthetic_las, tmp_path):
    out = tmp_path / "o"
    rc = main([str(synthetic_las["wkt_ftus"]), str(out), "--max-points", "100000", "--demo", "20000",
               "--cell-size", "64", "--name", "syn", "--source", "u", "--license", "l"])
    assert rc == 0
    full = json.load(open(out / "manifest.json"))
    demo = json.load(open(out / "demo" / "manifest.json"))
    assert full["pointCount"] == 100_000 and demo["pointCount"] == 20_000
    assert full["bounds"] == demo["bounds"]
    assert full["name"] == "syn" and full["source"] == "u" and full["license"] == "l"
    assert (out / "demo" / "points.bin").stat().st_size == 20_000 * 8


def test_cli_reads_source_json(synthetic_las, tmp_path):
    src = synthetic_las["geokeys"]
    (src.parent / f"{src.stem}.source.json").write_text(json.dumps({"url": "http://x/t.zip", "name": "tile-x", "license": "OGL"}))
    out = tmp_path / "o2"
    assert main([str(src), str(out)]) == 0
    m = json.load(open(out / "manifest.json"))
    assert (m["name"], m["source"], m["license"]) == ("tile-x", "http://x/t.zip", "OGL")


def test_cli_no_crs_errors(synthetic_las, tmp_path, capsys):
    rc = main([str(synthetic_las["none"]), str(tmp_path / "o3")])
    assert rc == 2 and "--units" in capsys.readouterr().err
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/.venv/bin/pytest tools/tests -q -k "stats or cli"`
Expected: `ImportError: cannot import name 'main'`.

- [ ] **Step 3: Implement**

Append to `tools/preprocess.py` (add `import argparse, sys, time` at the top):
```python
def stats(cloud: Cloud) -> dict:
    codes, counts = np.unique(cloud.cls, return_counts=True)
    n = len(cloud.cls)
    p1, p50, p99 = np.percentile(cloud.intensity, [1, 50, 99])
    return {
        "count": n,
        "bounds": {"min": cloud.xyz.min(axis=0).tolist(), "max": cloud.xyz.max(axis=0).tolist()},
        "unitSource": cloud.units.source,
        "unitFactors": {"xy": cloud.units.xy, "z": cloud.units.z},
        "classes": {int(c): {"name": class_name(int(c)), "count": int(k), "pct": 100.0 * k / n} for c, k in zip(codes, counts)},
        "intensity": {"p1": float(p1), "p50": float(p50), "p99": float(p99)},
    }


def format_stats(s: dict) -> str:
    lines = [f"points: {s['count']:,}",
             f"bounds (m): min {s['bounds']['min']} max {s['bounds']['max']}",
             f"unit source: {s['unitSource']} (xy ×{s['unitFactors']['xy']:.6f}, z ×{s['unitFactors']['z']:.6f})",
             "classes:"]
    for code, c in sorted(s["classes"].items()):
        lines.append(f"  {code:3d} {c['name']:<26} {c['count']:>12,} {c['pct']:6.2f}%")
    i = s["intensity"]
    lines.append(f"intensity p1/p50/p99: {i['p1']:.0f} / {i['p50']:.0f} / {i['p99']:.0f}")
    return "\n".join(lines)


def _default_meta(in_path: Path) -> dict:
    meta = {"name": in_path.stem, "source": "", "license": ""}
    sj = in_path.with_name(f"{in_path.stem}.source.json")
    if sj.exists():
        with open(sj) as f:
            d = json.load(f)
        meta.update({"name": d.get("name", meta["name"]), "source": d.get("url", ""), "license": d.get("license", "")})
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("out_dir")
    ap.add_argument("--max-points", type=int, default=None)
    ap.add_argument("--cell-size", type=float, default=64.0, help="chunk cell size in metres")
    ap.add_argument("--demo", type=int, default=None, help="also write a subsampled dataset of N points to OUT_DIR/demo")
    ap.add_argument("--units", choices=["auto", "m", "ft", "ftus"], default="auto")
    ap.add_argument("--z-units", choices=["auto", "m", "ft", "ftus"], default="auto")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--name"); ap.add_argument("--source"); ap.add_argument("--license")
    ap.add_argument("--stats", action="store_true", help="print statistics and exit")
    a = ap.parse_args(argv)

    t0 = time.perf_counter()
    try:
        cloud = load_cloud(a.input, a.units, a.z_units)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"loaded {len(cloud.xyz):,} points in {time.perf_counter() - t0:.1f} s", file=sys.stderr)
    if a.stats:
        print(format_stats(stats(cloud)))
        return 0

    if a.max_points:
        cloud = subsample(cloud, a.max_points, a.seed)
    q, bounds = quantize_cloud(cloud.xyz)
    packed = pack_attr(normalize_intensity(cloud.intensity), cloud.cls)
    meta = _default_meta(Path(a.input))
    for k in ("name", "source", "license"):
        if getattr(a, k):
            meta[k] = getattr(a, k)
    meta["crs"] = cloud.crs
    out = Path(a.out_dir)
    m = write_dataset(out, cloud.xyz, q, packed, cloud.cls, bounds, a.cell_size, a.seed, meta)
    print(f"wrote {out / 'points.bin'}: {m['pointCount']:,} points, {len(m['chunks'])} chunks", file=sys.stderr)
    if a.demo:
        sel = np.random.default_rng(a.seed + 1).permutation(len(q))[: a.demo]
        d = write_dataset(out / "demo", cloud.xyz[sel], q[sel], packed[sel], cloud.cls[sel], bounds, a.cell_size, a.seed, meta)
        print(f"wrote {out / 'demo' / 'points.bin'}: {d['pointCount']:,} points, {len(d['chunks'])} chunks", file=sys.stderr)
    print(f"total {time.perf_counter() - t0:.1f} s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `25 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/preprocess.py tools/tests/test_preprocess.py
git commit -m "preprocess: cli with --stats, --max-points, --demo, source.json metadata"
```

---

### Task 5: `fetch.py`: tile listing + zip import; download the downtown tile

**Files:**
- Create: `tools/fetch.py`
- Test: `tools/tests/test_fetch.py`

**Interfaces:**
- Produces: `API`, `TILE_URL` constants; `list_tiles() -> list[dict]` (`{name, url, e, n}`); `sort_near(tiles, e: float, n: float) -> list[dict]`; `import_zip(zip_path: Path, name: str, out_dir: Path, url: str) -> Path` (extracted LAS/LAZ path; writes `<name>.source.json`).
- CLI: `fetch.py --list [--near E N] [--limit 20]`; `fetch.py --import ZIP --name NAME [--url URL]`.

- [ ] **Step 1: Failing test**

`tools/tests/test_fetch.py`:
```python
import json
import zipfile

from fetch import TILE_URL, import_zip, sort_near


def test_sort_near_orders_by_tile_centre():
    tiles = [{"name": "480000_5455000", "url": "", "e": 480000, "n": 5455000},
             {"name": "491000_5458000", "url": "", "e": 491000, "n": 5458000}]
    assert [t["name"] for t in sort_near(tiles, 491500, 5458500)] == ["491000_5458000", "480000_5455000"]


def test_import_zip_extracts_single_las(synthetic_las, tmp_path):
    z = tmp_path / "491000_5458000.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.write(synthetic_las["none"], "491000_5458000.las")
        zf.writestr("readme.txt", "ignored")
    out = import_zip(z, "vancouver-test", tmp_path / "raw", TILE_URL.format(name="491000_5458000"))
    assert out == tmp_path / "raw" / "vancouver-test.las" and out.stat().st_size == synthetic_las["none"].stat().st_size
    src = json.load(open(tmp_path / "raw" / "vancouver-test.source.json"))
    assert src["name"] == "vancouver-test" and src["url"].endswith("491000_5458000.zip")
    assert src["license"] == "Open Government Licence – Vancouver"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tools/.venv/bin/pytest tools/tests/test_fetch.py -q`
Expected: `ModuleNotFoundError: No module named 'fetch'`.

- [ ] **Step 3: Implement**

`tools/fetch.py`:
```python
#!/usr/bin/env python3
"""City of Vancouver LiDAR 2022: list tiles (open-data API) and import a browser-downloaded zip.

The file host (webtransfer.vancouver.ca) answers scripted requests with a Cloudflare browser
challenge, so the zip itself must be downloaded in a browser; --import unpacks it into data/raw.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

API = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/lidar-2022/records"
TILE_URL = "https://webtransfer.vancouver.ca/opendata/2022LiDAR/{name}.zip"
LICENSE = "Open Government Licence – Vancouver"
LICENSE_URL = "https://opendata.vancouver.ca/pages/licence/"
RAW_DIR = Path(__file__).resolve().parents[1] / "data" / "raw"


def list_tiles() -> list[dict]:
    tiles: list[dict] = []
    offset = 0
    while True:
        with urllib.request.urlopen(f"{API}?select=name,lidar_url&limit=100&offset={offset}", timeout=60) as r:
            results = json.load(r)["results"]
        if not results:
            return tiles
        for it in results:
            e, n = (int(v) for v in it["name"].split("_"))
            tiles.append({"name": it["name"], "url": it["lidar_url"], "e": e, "n": n})
        offset += 100


def sort_near(tiles: list[dict], e: float, n: float) -> list[dict]:
    return sorted(tiles, key=lambda t: (t["e"] + 500 - e) ** 2 + (t["n"] + 500 - n) ** 2)


def import_zip(zip_path: Path, name: str, out_dir: Path, url: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = [m for m in zf.namelist() if m.lower().endswith((".las", ".laz"))]
        if len(members) != 1:
            raise ValueError(f"expected exactly one .las/.laz in {zip_path}, found {members}")
        ext = Path(members[0]).suffix.lower()
        dst = out_dir / f"{name}{ext}"
        with zf.open(members[0]) as src, open(dst, "wb") as f:
            shutil.copyfileobj(src, f, 1 << 20)
    with open(out_dir / f"{name}.source.json", "w") as f:
        json.dump({"url": url, "name": name, "imported": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "license": LICENSE, "licenseUrl": LICENSE_URL}, f, indent=1)
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--near", nargs=2, type=float, metavar=("E", "N"), help="UTM 10N metres")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--import", dest="zip", help="zip downloaded from the tile URL")
    ap.add_argument("--name", help="dataset name used for data/raw/<name>.las")
    ap.add_argument("--url", help="source URL recorded in source.json (default: tile URL from the zip name)")
    a = ap.parse_args(argv)
    if a.list:
        tiles = list_tiles()
        if a.near:
            tiles = sort_near(tiles, *a.near)
        for t in tiles[: a.limit]:
            print(f"{t['name']}  {t['url']}")
        print(f"{len(tiles)} tiles; licence: {LICENSE} ({LICENSE_URL})", file=sys.stderr)
        return 0
    if a.zip:
        zp = Path(a.zip)
        name = a.name or zp.stem
        url = a.url or TILE_URL.format(name=zp.stem)
        out = import_zip(zp, name, RAW_DIR, url)
        print(out)
        return 0
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `27 passed`.

- [ ] **Step 5: List tiles near downtown (live API)**

Run: `tools/.venv/bin/python tools/fetch.py --list --near 491500 5458500 --limit 5`
Expected: first line `491000_5458000  https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip`, then its neighbours; stderr `181 tiles; licence: …`.

- [ ] **Step 6: Download the tile in a browser (one-time, not scripted)**

Use the Chrome MCP tools: `tabs_context_mcp`, then `tabs_create_mcp`, then `navigate` to `https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip`. Chrome passes the Cloudflare challenge and saves the zip to `~/Downloads/491000_5458000.zip` (the dataset notes say 16 MB to 2.74 GB per tile; expect several hundred MB, wait for `ls -la ~/Downloads/491000_5458000.zip*` to stop growing and the `.crdownload` suffix to disappear). If the Chrome MCP is unavailable, download it by hand in any browser. Do not attempt to bypass the challenge from a script.

- [ ] **Step 7: Import and vet**

```bash
tools/.venv/bin/python tools/fetch.py --import ~/Downloads/491000_5458000.zip --name vancouver-downtown
tools/.venv/bin/python tools/preprocess.py data/raw/vancouver-downtown.las data/processed/vancouver-downtown --stats
```
Expected: `unit source: wkt` (UTM 10N metres, xy ×1, z ×1), a class table containing `5 High Vegetation` and `6 Building` each ≥ 3 %, `points:` ≥ 5,000,000. Record the exact table in `docs/ARCHITECTURE.md` (Task 8). If the tile fails the vetting rule, repeat Steps 6–7 with `490000_5458000`, then `491000_5457000`, then `492000_5458000`, and change `--name` to `vancouver-<area>`. If the LAS inside the zip is `.laz`, the path is `data/raw/vancouver-downtown.laz` — adjust the commands.

- [ ] **Step 8: Commit**

```bash
git add tools/fetch.py tools/tests/test_fetch.py
git commit -m "fetch: vancouver tile listing and zip import"
```

---

### Task 6: Build the full and demo datasets

**Files:**
- Modify: `docs/ARCHITECTURE.md` (numbers only; section written in Task 8)

- [ ] **Step 1: Run preprocess**

```bash
time tools/.venv/bin/python tools/preprocess.py data/raw/vancouver-downtown.las data/processed/vancouver-downtown \
  --max-points 20000000 --demo 2000000 --cell-size 64 --name vancouver-downtown
```
Expected stderr: `loaded N points in … s`, `wrote …/points.bin: 20,000,000 points, ≤256 chunks`, `wrote …/demo/points.bin: 2,000,000 points, ≤256 chunks`, `total … s`. Spec target: under 2 minutes; record the actual `total` and the `real` time.

- [ ] **Step 2: Sanity checks**

```bash
ls -l data/processed/vancouver-downtown/points.bin data/processed/vancouver-downtown/demo/points.bin
tools/.venv/bin/python - <<'EOF'
import json, numpy as np
for d in ("data/processed/vancouver-downtown", "data/processed/vancouver-downtown/demo"):
    m = json.load(open(f"{d}/manifest.json"))
    words = np.fromfile(f"{d}/points.bin", dtype="<u2").reshape(-1, 4)
    assert words.shape[0] == m["pointCount"] == sum(c["count"] for c in m["chunks"])
    offs = [c["offset"] for c in m["chunks"]]; assert offs == sorted(offs) and offs[0] == 0
    print(d, m["pointCount"], len(m["chunks"]), m["classMap"], m["bounds"])
EOF
```
Expected: `points.bin` sizes 160,000,000 and 16,000,000 bytes; both manifests share `bounds`; `classMap` includes `"5": "High Vegetation"` and `"6": "Building"`.

- [ ] **Step 3: Note the numbers**

Append to `docs/ARCHITECTURE.md` under a new heading `## Phase 1: data pipeline` (filled in fully in Task 8): source tile, raw point count, class table from `--stats`, preprocess wall time, chunk counts. Commit:
```bash
git add docs/ARCHITECTURE.md
git commit -m "phase 1: dataset build numbers"
```

---

### Task 7: `check_hosting.py`, release `v0.1-data`, hosting verification

**Files:**
- Create: `tools/check_hosting.py`, `data/release/` (gitignored staging), `docs/release-notes-v0.1-data.md`
- Test: `tools/tests/test_check_hosting.py`

**Interfaces:**
- Produces: `Hop` dataclass `(url: str, status: int, headers: dict[str, str], body_len: int)`; `walk(url: str, origin: str, max_hops: int = 10) -> list[Hop]` (manual redirects, `Range: bytes=0-15` and `Origin` on every request); `evaluate(hops: list[Hop], origin: str) -> list[tuple[str, bool, str]]` (`(check, passed, detail)`); CLI `check_hosting.py URL` exits 1 on any failure.

- [ ] **Step 1: Failing test (pure `evaluate`)**

`tools/tests/test_check_hosting.py`:
```python
from check_hosting import Hop, evaluate

ORIGIN = "https://example.com"


def _ok_chain():
    return [
        Hop("https://github.com/x/releases/download/v/demo-points.bin", 302,
            {"location": "https://objects.githubusercontent.com/x", "access-control-allow-origin": "*"}, 0),
        Hop("https://objects.githubusercontent.com/x", 206,
            {"content-range": "bytes 0-15/16000000", "access-control-allow-origin": "*", "accept-ranges": "bytes"}, 16),
    ]


def test_evaluate_passes_good_chain():
    res = evaluate(_ok_chain(), ORIGIN)
    assert all(ok for _, ok, _ in res) and len(res) == 5   # cors ×2 hops, range 206, content-range, accept-ranges


def test_evaluate_fails_missing_cors_on_redirect():
    hops = _ok_chain()
    del hops[0].headers["access-control-allow-origin"]
    res = dict((name, ok) for name, ok, _ in evaluate(hops, ORIGIN))
    assert res["cors hop 1"] is False and res["range 206"] is True


def test_evaluate_fails_200_without_content_range():
    hops = _ok_chain()
    hops[1] = Hop(hops[1].url, 200, {"access-control-allow-origin": "*"}, 16_000_000)
    res = dict((name, ok) for name, ok, _ in evaluate(hops, ORIGIN))
    assert res["range 206"] is False and res["content-range"] is False


def test_evaluate_accepts_echoed_origin():
    hops = _ok_chain()
    hops[1].headers["access-control-allow-origin"] = ORIGIN
    assert all(ok for _, ok, _ in evaluate(hops, ORIGIN))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tools/.venv/bin/pytest tools/tests/test_check_hosting.py -q`
Expected: `ModuleNotFoundError: No module named 'check_hosting'`.

- [ ] **Step 3: Implement**

`tools/check_hosting.py`:
```python
#!/usr/bin/env python3
"""Probe a hosted points.bin the way the viewer's loader will use it: Range GET + CORS on every hop."""
from __future__ import annotations

import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class Hop:
    url: str
    status: int
    headers: dict[str, str]
    body_len: int


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def walk(url: str, origin: str, max_hops: int = 10) -> list[Hop]:
    opener = urllib.request.build_opener(_NoRedirect())
    hops: list[Hop] = []
    for _ in range(max_hops):
        req = urllib.request.Request(url, headers={"Range": "bytes=0-15", "Origin": origin, "User-Agent": "check_hosting/1"})
        try:
            with opener.open(req, timeout=60) as r:
                body = r.read()
                hops.append(Hop(url, r.status, {k.lower(): v for k, v in r.headers.items()}, len(body)))
                return hops
        except urllib.error.HTTPError as e:
            headers = {k.lower(): v for k, v in e.headers.items()}
            hops.append(Hop(url, e.code, headers, 0))
            if e.code in (301, 302, 303, 307, 308) and "location" in headers:
                url = urllib.parse.urljoin(url, headers["location"])
                continue
            return hops
    return hops


def evaluate(hops: list[Hop], origin: str) -> list[tuple[str, bool, str]]:
    res: list[tuple[str, bool, str]] = []
    for i, h in enumerate(hops):
        acao = h.headers.get("access-control-allow-origin")
        res.append((f"cors hop {i + 1}", acao in ("*", origin), f"{h.status} {h.url} → access-control-allow-origin: {acao}"))
    last = hops[-1]
    res.append(("range 206", last.status == 206, f"status {last.status}"))
    cr = last.headers.get("content-range", "")
    res.append(("content-range", cr.startswith("bytes 0-15/") and last.body_len == 16, f"{cr!r}, body {last.body_len} B"))
    res.append(("accept-ranges (informational)", True, f"{last.headers.get('accept-ranges')!r}"))
    return res


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: check_hosting.py URL", file=sys.stderr)
        return 2
    origin = "https://example.com"
    hops = walk(argv[0], origin)
    for h in hops:
        print(f"{h.status} {h.url}")
    failed = False
    for name, ok, detail in evaluate(hops, origin):
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failed |= not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tools/.venv/bin/pytest tools/tests -q`
Expected: `31 passed`.

- [ ] **Step 5: Stage assets and create the release**

```bash
mkdir -p data/release
cp data/processed/vancouver-downtown/demo/manifest.json data/release/demo-manifest.json
cp data/processed/vancouver-downtown/demo/points.bin   data/release/demo-points.bin
cp data/processed/vancouver-downtown/manifest.json      data/release/full-manifest.json
cp data/processed/vancouver-downtown/points.bin         data/release/full-points.bin
```

`docs/release-notes-v0.1-data.md`:
```markdown
# Dataset v0.1 — Vancouver downtown (LiDAR 2022)

Source: City of Vancouver LiDAR 2022, tile `491000_5458000`
(https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip), UTM 10N NAD83(CSRS), CGVD28, metres.
Contains information licensed under the Open Government Licence – Vancouver
(https://opendata.vancouver.ca/pages/licence/).

Assets (v1 point format, 8 B/pt, see docs/ARCHITECTURE.md):
- `full-manifest.json` + `full-points.bin` — 20,000,000 points (uniform subsample of <RAW> raw points), 64 m chunks
- `demo-manifest.json` + `demo-points.bin` — 2,000,000 points, same quantization bounds

Built with `tools/preprocess.py … --max-points 20000000 --demo 2000000 --cell-size 64 --seed 1`.
```
Replace `<RAW>` with the raw count from Task 5 Step 7.

```bash
gh release create v0.1-data --title "Dataset v0.1 (Vancouver downtown)" --notes-file docs/release-notes-v0.1-data.md \
  data/release/demo-manifest.json data/release/demo-points.bin data/release/full-manifest.json data/release/full-points.bin
gh release view v0.1-data --json assets --jq '.assets[] | "\(.name) \(.size)"'
```
Expected: four assets with sizes 16,000,000 and 160,000,000 for the bins.

- [ ] **Step 6: Verify hosting**

```bash
tools/.venv/bin/python tools/check_hosting.py https://github.com/merttoka/point-cloud-editor/releases/download/v0.1-data/demo-points.bin
tools/.venv/bin/python tools/check_hosting.py https://github.com/merttoka/point-cloud-editor/releases/download/v0.1-data/full-points.bin
```
Expected: redirect chain `302 github.com → 206 objects.githubusercontent.com`, every line `PASS`, exit 0. If any `cors hop` fails, the browser will block the download: fall back per the spec to hosting the four files on the website static host (`/Users/toka/Professional/Public/website/public_html`, `git-ftp`; read that folder's `CLAUDE.md` first) and change the base URL in Task 8's script. If only `range 206` fails, keep the release (the loader's full-fetch fallback covers it) and record it in ARCHITECTURE.

- [ ] **Step 7: Commit**

```bash
git add tools/check_hosting.py tools/tests/test_check_hosting.py docs/release-notes-v0.1-data.md
git commit -m "check_hosting: redirect-aware range + cors probe; v0.1-data release notes"
```

---

### Task 8: `npm run data:*`, README, ARCHITECTURE, merge

**Files:**
- Create: `scripts/fetch-data.mjs`
- Modify: `package.json`, `README.md`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Produces: `npm run data:demo`, `npm run data:full` → `public/data/<name>/{manifest.json,points.bin}`.

- [ ] **Step 1: Script**

`scripts/fetch-data.mjs`:
```js
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const name = process.argv[2]
if (!['demo', 'full'].includes(name)) {
  console.error('usage: node scripts/fetch-data.mjs demo|full')
  process.exit(1)
}
const base = 'https://github.com/merttoka/point-cloud-editor/releases/download/v0.1-data/'
const dir = `public/data/${name}`
mkdirSync(dir, { recursive: true })
for (const [asset, file] of [[`${name}-manifest.json`, 'manifest.json'], [`${name}-points.bin`, 'points.bin']]) {
  const res = await fetch(base + asset)
  if (!res.ok || !res.body) throw new Error(`${asset}: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length'))
  const dst = `${dir}/${file}`
  if (existsSync(dst) && len > 0 && statSync(dst).size === len) {
    console.log(`skip ${dst} (${len} B, already complete)`)
    continue
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dst))
  console.log(`wrote ${dst} (${statSync(dst).size} B)`)
}
```

`package.json` scripts, add:
```json
"data:demo": "node scripts/fetch-data.mjs demo",
"data:full": "node scripts/fetch-data.mjs full"
```

- [ ] **Step 2: Run it**

```bash
rm -rf public/data && npm run data:demo && ls -l public/data/demo && npm run data:demo
```
Expected: first run writes `manifest.json` and `points.bin` (16,000,000 B); second run prints `skip …` for both. `git status` shows `public/data/` untracked-ignored.

- [ ] **Step 3: README**

Replace the `## Status` line with `Phase 1 done: Vancouver downtown dataset on release v0.1-data; preprocess tools in tools/.` and add after `## Setup`:
```markdown
## Data

Demo (2M points, 16 MB) and full (20M, 160 MB) datasets are GitHub Release assets (`v0.1-data`):

```bash
npm run data:demo   # → public/data/demo/{manifest.json,points.bin}
npm run data:full   # → public/data/full/
```

Source: City of Vancouver LiDAR 2022, tile `491000_5458000` (downtown), UTM 10N metres, ~49 pts/m².
Contains information licensed under the Open Government Licence – Vancouver (https://opendata.vancouver.ca/pages/licence/).

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
Preprocess of the raw tile (<RAW> points → 20M + 2M) takes <T> s on an M4 Max.
```
Fill `<RAW>` and `<T>` from Task 6.

- [ ] **Step 4: ARCHITECTURE**

Replace the Task 6 stub with a full `## Phase 1: data pipeline` section: point format (bytes, words, `packed` layout), manifest schema (copy the JSON shape from the spec with the real `name`/`classMap`), chunking (64 m XY grid, row-major `(iy, ix)`, empty cells omitted, per-chunk seeded shuffle and why: any prefix is a uniform subsample for the budget slider), unit handling (WKT in VLR or EVLR, GeoTIFF keys 3076/4099, explicit flags; the three vetted 3DEP tiles and why they were rejected: baseline classes only; A10), the chosen tile's `--stats` table, preprocess timing, hosting (release assets, redirect chain, `check_hosting` output verbatim, the loader's Range + full-fetch fallback contract), memory note (float64 XYZ ≈ 24 B/pt while loading).

- [ ] **Step 5: Final checks**

```bash
tools/.venv/bin/pytest tools/tests -q      # 31 passed
npm test                                    # vitest still 12 passed
npm run build                               # clean
git status --short                          # no data/, public/data, tools/.venv entries
```

- [ ] **Step 6: Commit, merge, push**

```bash
git add scripts/fetch-data.mjs package.json README.md docs/ARCHITECTURE.md
git commit -m "phase 1: data fetch script, readme data section, architecture data pipeline"
git checkout main
git merge --no-ff phase-1-preprocess -m "merge phase-1-preprocess"
git branch -d phase-1-preprocess
git push origin main
```

---

## Self-review notes

- Spec coverage: layout + venv (T1), `fetch.py --list/--import` with the Cloudflare note and tile list (T5), `preprocess.py` steps 1–7 incl. `--units/--z-units` from WKT (VLR or EVLR) / GeoTIFF keys / explicit, `--stats`, `--max-points`, `--demo` with same bounds, chunking + shuffle, zero-intensity guard (T2–T4), manifest fields incl. `name/source/license/crs` (T3–T4), `check_hosting.py` hop-by-hop CORS + authoritative Range (T7), release with four flat assets (T7), `fetch-data.mjs` with size-skip (T8), acceptance criteria: vetting (T5.7), sizes/sums/offsets (T6.2), demo 2M same bounds (T4 test + T6.2), hosting PASS (T7.6), clean-clone `npm run data:demo` (T8.2), pytest green + timing in README (T8).
- Spec tests: quantization bound ✓, chunk sums/offsets/order ✓, manifest schema ✓, feet/GeoTIFF/no-CRS variants ✓, `--stats` no writes ✓, zero intensity ✓, prefix uniformity ±3 pp ✓, `--demo` count + bounds ✓, `--max-points` ✓, byte layout ✓ (`test_write_dataset_layout_and_manifest` reads `<u2` words and checks `packed >> 8` is a class).
- Type/name consistency: `Units(xy, z, source)`, `Cloud(xyz, intensity, cls, crs, units)`, `Chunk(offset, count, bounds)`, `write_dataset(out_dir, xyz, q, packed, cls, bounds, cell, seed, meta)` used identically in T3 tests, T4 `main`, and the demo branch; `import_zip(zip_path, name, out_dir, url)` in T5 test and CLI; `Hop`/`evaluate` names match in T7.
- Test count progression: 6 → 14 → 20 → 25 → 27 → 31.
- Numbers to fill during execution: raw point count and preprocess time (T6), release asset sizes (T7), `<RAW>`/`<T>` placeholders in README and release notes (T8) — these are measurement outputs, not design gaps.
