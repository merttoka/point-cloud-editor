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
