# Dataset v0.1 — Vancouver downtown (LiDAR 2022)

Source: City of Vancouver LiDAR 2022, tile `491000_5458000`
(https://webtransfer.vancouver.ca/opendata/2022LiDAR/491000_5458000.zip), UTM 10N NAD83(CSRS), CGVD28, metres.
Contains information licensed under the Open Government Licence – Vancouver
(https://opendata.vancouver.ca/pages/licence/).

Assets (v1 point format, 8 B/pt, see docs/ARCHITECTURE.md):
- `full-manifest.json` + `full-points.bin` — 20,000,000 points (uniform subsample of 51,494,885 raw points), 64 m chunks
- `demo-manifest.json` + `demo-points.bin` — 2,000,000 points, same quantization bounds

Built with `tools/preprocess.py … --max-points 20000000 --demo 2000000 --cell-size 64 --seed 1`.
