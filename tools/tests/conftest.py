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
FT_US = 1200 / 3937


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
    # wkt_ftus and geokeys store coords in US-survey-feet; scale by FT_US so 2×2 grid spans 64m cells not ~39m
    # Rounding margin so the 2×2 grid at 64 m holds
    if crs in ("wkt_ftus", "geokeys"):
        las.x = rng.uniform(0, (2 * CELL - 0.5) / FT_US, N)
        las.y = rng.uniform(0, (2 * CELL - 0.5) / FT_US, N)
    else:
        las.x = rng.uniform(0, 2 * CELL - 0.5, N)
        las.y = rng.uniform(0, 2 * CELL - 0.5, N)
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
