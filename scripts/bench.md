# Bench runbook

Every number in README § Performance cites a row in `docs/bench/<date>-<machine>.json` produced by these steps. One
`browser_evaluate` per dataset; nothing polls the page while the full set streams.

## Environment (record in the row's `env` and in the JSON file name)
- Machine, macOS, Chromium version (`navigator.userAgent` is in the row), Playwright MCP (runs a headed Chrome window), DPR 1 (`?dpr=1`), point size 2 px, viewport 1277×860 (`browser_resize`).
- Close every other tab first (`browser_tabs`): the dev-server smoke row, taken with earlier tabs open, read a 2M compute total of 142 ms against 82 ms in a clean browser.
- The frame floor is the refresh rate of the display the window sits on (4.17 ms at 240 Hz, 8.33 ms at 120 Hz); check with `setBudget(0.05)` — if the frame doesn't drop, it's vsync.
- Serve the production build: `npm run build && npm run preview` → `http://localhost:4173/point-cloud/app/`.

## Per dataset
1. GPU-process RSS before: `ps -eo rss,command | grep -- '--type=gpu-process' | grep -v grep` (KB).
2. `browser_navigate` `http://localhost:4173/point-cloud/app/?bench=1&dpr=1&data=demo` (`full` for 10M/20M rows).
3. `browser_wait_for` text `2,000,000 / 2,000,000` (demo) or `20,000,000 / 20,000,000` (full). Time budget: ≤ 10 s demo, ≤ 60 s full.
4. 10M row only: `browser_evaluate` `() => __pcv.setBudget(0.5)`.
5. `browser_evaluate` `async () => JSON.stringify(await __pcv.runAll({ skipCpu: true }))` → paste the JSON as the row (2M/10M/20M keys `frameDefault`, `framePostOrbit`, `edlOff`, `edlOn`, `renderGpuMs`, `compute`, `lasso`, `pickMs`, `memory`, `loadMs`).
6. Demo only, two more evaluates (each ≈ 15 s, kept separate from runAll so no single evaluate exceeds the MCP timeout):
   `async () => JSON.stringify(await __pcv.cpuBench())` and `async () => JSON.stringify(await __pcv.verify())` → fill `cpuBench`, `verify`.
7. GPU-process RSS after (same `ps` line) → row `rssDeltaKB` (added by hand; not part of `runAll`).
8. `browser_console_messages` → must be clean (no errors, no `GPUValidationError`).
9. Headed run (optional): same steps in Chrome via the Chrome MCP; store as a second file `…-headed.json`.

## Row → README
| README cell | row key |
|---|---|
| load time | `loadMs` |
| frame default → post-orbit | `frameDefault.ms/fps` → `framePostOrbit.ms/fps`, `draws` |
| EDL delta | `edlOff.ms` vs `edlOn.ms`, `renderGpuMs` |
| compute per pass | `compute.{countMs,scanMs,scatterMs,normalsMs,aoMs,totalMs}` (GPU) and `compute.wallMs` |
| CPU bench / verify | `cpuBench.*`, `verify.*` (demo only) |
| lasso / pick | `lasso.gpuMs`, `lasso.readbackMs`, `lasso.selected` (= `lasso.cpuSelected`), `pickMs` (median of 5) |
| memory computed / RSS proxy | `memory.total` / `rssDeltaKB` |

## Media
- `hero.webm`: on the demo, `browser_evaluate` `async () => { const p = __pcv.record(12, 'hero.webm'); await __pcv.orbit(60, 6000); await __pcv.lasso([[300,200],[900,200],[900,600],[300,600]]); __pcv.editor.split(); await __pcv.settle(1500); __pcv.edl(false); await __pcv.settle(1500); __pcv.edl(true); return JSON.stringify(await p) }` → file lands in the Playwright download dir (`.playwright-mcp/`). Then `ffmpeg -i hero.webm -c:v libvpx-vp9 -b:v 1.5M -vf scale=1280:-2 docs/media/hero.webm` and `ffmpeg -i hero.webm -c:v libx264 -crf 23 -pix_fmt yuv420p -vf scale=1280:-2 docs/media/hero.mp4`.
  `record()` worked in the Playwright Chrome (VP9, 1280×720 @ 30 fps, ~4.3 MB raw → 1.9 MB webm / 0.7 MB mp4); the download lands in `.playwright-mcp/hero.webm`. Add `-an` to both ffmpeg calls.
- PNGs: `browser_resize` 1280×720, `browser_take_screenshot` for overview / classification / normals+AO / lasso / split.
- Fallback if `record()` rejects (no MediaRecorder): 30 screenshots during `orbit(30, 6000)` → `ffmpeg -framerate 5 -i frame_%02d.png …`.
