#!/usr/bin/env python3
"""LAS/LAZ → v1 point format: points.bin (8 B/pt, u16 LE) + manifest.json."""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from laspy.vlrs.known import GeoKeyDirectoryVlr, WktCoordinateSystemVlr

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
