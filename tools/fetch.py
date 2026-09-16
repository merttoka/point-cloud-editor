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
