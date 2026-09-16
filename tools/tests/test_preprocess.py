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
