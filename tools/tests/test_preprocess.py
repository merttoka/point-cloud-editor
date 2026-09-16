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


def test_units_from_wkt2_lengthunit_before_angleunit():
    wkt = ('PROJCRS["x",CS[Cartesian,2],AXIS["(E)",east,LENGTHUNIT["metre",1]],AXIS["(N)",north,LENGTHUNIT["metre",1]],'
           'BASEGEOGCRS["NAD83",ANGLEUNIT["degree",0.0174532925199433]]]')
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


import json
import shutil
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
    mn = xyz.min(axis=0)
    order, chunks = chunk_order(xyz, mn, CELL, 1)
    assert sorted(order.tolist()) == list(range(30_000))
    assert sum(c.count for c in chunks) == 30_000
    off = 0
    prev_key = -1
    for c in chunks:
        assert c.offset == off
        off += c.count
        sl = xyz[order[c.offset:c.offset + c.count]]
        ix, iy = int((sl[0, 0] - mn[0]) // CELL), int((sl[0, 1] - mn[1]) // CELL)
        assert np.all((sl[:, 0] - mn[0]) // CELL == ix) and np.all((sl[:, 1] - mn[1]) // CELL == iy)
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
    order, _ = chunk_order(cloud.xyz, m["bounds"]["min"], CELL, 1)
    assert list(data[0]) == [*q[order[0]].tolist(), int(packed[order[0]])]
    assert m["chunks"][0]["count"] > 5_000


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
    src = Path(shutil.copy(synthetic_las["geokeys"], tmp_path / "geokeys.las"))
    src.with_name(f"{src.stem}.source.json").write_text(json.dumps({"url": "http://x/t.zip", "name": "tile-x", "license": "OGL"}))
    out = tmp_path / "o2"
    assert main([str(src), str(out)]) == 0
    m = json.load(open(out / "manifest.json"))
    assert (m["name"], m["source"], m["license"]) == ("tile-x", "http://x/t.zip", "OGL")


def test_cli_no_crs_errors(synthetic_las, tmp_path, capsys):
    rc = main([str(synthetic_las["none"]), str(tmp_path / "o3")])
    assert rc == 2 and "--units" in capsys.readouterr().err
