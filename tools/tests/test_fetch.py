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
