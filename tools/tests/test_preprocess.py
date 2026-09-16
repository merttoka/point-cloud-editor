import laspy
import numpy as np
import pytest

from conftest import WKT_FTUS
from preprocess import QMAX, FT_US, class_name, crs_string, normalize_intensity, pack_attr, quantize_cloud, resolve_units, units_from_wkt


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
