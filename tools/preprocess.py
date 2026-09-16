#!/usr/bin/env python3
"""LAS/LAZ → v1 point format: points.bin (8 B/pt, u16 LE) + manifest.json."""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import laspy
import numpy as np
from laspy.vlrs.known import GeoKeyDirectoryVlr, WktCoordinateSystemVlr

QMAX = 65535
BYTES_PER_POINT = 8   # 4 × u16 (x, y, z, intensity | class<<8); mirrors src/viewer/format/quant.ts
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


def bounds_of(xyz: np.ndarray) -> dict:
    return {"min": xyz.min(axis=0).tolist(), "max": xyz.max(axis=0).tolist()}


def quantize_cloud(xyz: np.ndarray) -> tuple[np.ndarray, dict]:
    mn, mx = xyz.min(axis=0), xyz.max(axis=0)
    span = np.where(mx > mn, mx - mn, 1.0)   # degenerate axis: numerator is 0 everywhere, so q stays 0
    # One n×3 float64 scratch, updated in place: keeps peak memory at ~1 temp instead of one per operator.
    t = xyz - mn
    t /= span
    t *= QMAX
    np.rint(t, out=t)
    np.clip(t, 0, QMAX, out=t)
    return t.astype(np.uint16), {"min": mn.tolist(), "max": mx.tolist()}


def normalize_intensity(i: np.ndarray) -> np.ndarray:
    p1, p99 = np.percentile(i, [1, 99])
    if p99 <= p1:
        return np.zeros(i.shape, np.uint8)
    return np.clip(np.rint((i.astype(np.float64) - p1) / (p99 - p1) * 255), 0, 255).astype(np.uint8)


def pack_attr(intensity8: np.ndarray, cls: np.ndarray) -> np.ndarray:
    return intensity8.astype(np.uint16) | (cls.astype(np.uint16) << 8)


_UNIT_RE = re.compile(r'(?<![A-Z])(?:LENGTH)?UNIT\["([^"]+)"')
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
    if "kilo" in n or "centi" in n or "milli" in n:
        return None
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
    np.multiply(las.x, u.xy, out=xyz[:, 0])
    np.multiply(las.y, u.xy, out=xyz[:, 1])
    np.multiply(las.z, u.z, out=xyz[:, 2])
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
    mx = xyz.max(axis=0)
    ix = np.floor((xyz[:, 0] - mn[0]) / cell).astype(np.int64)
    iy = np.floor((xyz[:, 1] - mn[1]) / cell).astype(np.int64)
    # Points on the max edge land in the last cell of the ceil'd grid instead of opening a new one
    ncx = max(1, int(np.ceil((mx[0] - mn[0]) / cell)))
    ncy = max(1, int(np.ceil((mx[1] - mn[1]) / cell)))
    ix = np.minimum(ix, ncx - 1)
    iy = np.minimum(iy, ncy - 1)
    key = iy * ncx + ix
    order = np.argsort(key, kind="stable")
    sorted_keys = key[order]
    starts = np.concatenate([[0], np.flatnonzero(np.diff(sorted_keys)) + 1, [len(order)]])
    rng = np.random.default_rng(seed)
    chunks: list[Chunk] = []
    for s, e in zip(starts[:-1], starts[1:]):
        seg = order[s:e]
        rng.shuffle(seg)
        chunks.append(Chunk(int(s), int(e - s), bounds_of(xyz[seg])))
    return order, chunks


def write_dataset(out_dir: Path, xyz, q, packed, cls, bounds: dict, cell: float, seed: int, meta: dict) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    order, chunks = chunk_order(xyz, bounds["min"], cell, seed)
    rec = np.empty((len(order), 4), "<u2")   # on-disk dtype: little-endian on every host
    rec[:, :3] = q[order]
    rec[:, 3] = packed[order]
    rec.tofile(out_dir / "points.bin")
    present = np.flatnonzero(np.bincount(cls, minlength=256))
    manifest = {
        "version": 1,
        "name": meta["name"], "source": meta["source"], "license": meta["license"],
        "crs": meta["crs"], "units": "m",
        "bounds": bounds,
        "pointCount": int(len(order)), "bytesPerPoint": BYTES_PER_POINT, "file": "points.bin",
        "classMap": {str(c): class_name(c) for c in present},
        "chunks": [{"offset": c.offset, "count": c.count, "bounds": c.bounds} for c in chunks],
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    return manifest


def stats(cloud: Cloud) -> dict:
    hist = np.bincount(cloud.cls, minlength=256)
    codes = np.flatnonzero(hist)
    n = len(cloud.cls)
    p1, p50, p99 = np.percentile(cloud.intensity, [1, 50, 99])
    bounds = bounds_of(cloud.xyz)
    factors = np.array([cloud.units.xy, cloud.units.xy, cloud.units.z])
    return {
        "count": n,
        "bounds": bounds,
        "nativeBounds": {"min": (bounds["min"] / factors).tolist(), "max": (bounds["max"] / factors).tolist()},
        "unitSource": cloud.units.source,
        "unitFactors": {"xy": cloud.units.xy, "z": cloud.units.z},
        "classes": {int(c): {"name": class_name(c), "count": int(k), "pct": 100.0 * k / n} for c, k in zip(codes, hist[codes])},
        "intensity": {"p1": float(p1), "p50": float(p50), "p99": float(p99)},
    }


def format_stats(s: dict) -> str:
    lines = [f"points: {s['count']:,}",
             f"bounds (native): min {s['nativeBounds']['min']} max {s['nativeBounds']['max']}",
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


def positive_int(s: str) -> int:
    n = int(s)
    if n < 1:
        raise argparse.ArgumentTypeError(f"must be a positive integer: {s!r}")
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("out_dir")
    ap.add_argument("--max-points", type=positive_int, default=None)
    ap.add_argument("--cell-size", type=float, default=64.0, help="chunk cell size in metres")
    ap.add_argument("--demo", type=positive_int, default=None, help="also write a subsampled dataset of N points to OUT_DIR/demo")
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
