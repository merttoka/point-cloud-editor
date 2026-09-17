# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor (three 0.186 `three/webgpu` + TSL, R3F 9.7, React 19, Vite 8, TS). Public repo, MIT. Portfolio piece for the Lab.

## Read first
- `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md` — master spec; **Amendments A1–A10 win** over per-phase specs.
- `docs/superpowers/specs/2026-09-15-phase-N-*-design.md` — phase spec (binding authority for that phase).
- `docs/ARCHITECTURE.md` — what exists, measured numbers, three 0.186 rules, `## Deferred` backlog.
- `docs/superpowers/specs/2026-09-17-spec-review-phases-3-6.md` — drift notes for phases 3–6 vs the shipped code; resolve before writing each plan.

## Phase workflow
1. Write the plan from the spec (`superpowers:writing-plans`) → `docs/superpowers/plans/`. Check the spec against current code first (specs were written before phases 1–2 shipped).
2. Branch `phase-N-<name>` from `main`; execute with `superpowers:subagent-driven-development` (fresh subagent per task, spec + quality review per task, final whole-branch review).
3. Gates before merge: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `tools/.venv/bin/pytest tools/tests -q`; browser checks via the Playwright MCP tools (`browser_navigate`, `browser_evaluate` on `#hud`, `browser_console_messages`, `browser_take_screenshot`).
4. Update `README.md` before every push; `docs/ARCHITECTURE.md` on merge (numbers, findings, Deferred list). Merge `git merge --no-ff`, push `main`, delete the branch.
5. After merge: a `/deslop` pass over the phase's changed surface, committed to `main`.

## Rules
- Commit messages concise, **no attribution / Co-Authored-By lines**.
- Pinned deps only (`three@0.186.0`, fiber `9.7.0`, drei `10.7.8`, react `19.3.0`, vite `8.3.0`); approved extras: vitest, pytest, `fflate`. No leva, no zustand, no pyproj.
- WebGPU only. Compute = raw WGSL via `wgslFn` + `storage()` nodes; every kernel **returns a value and is `.toVar()`-ed**; never `toReadOnly()` on a shared storage node; flags writes are thread-per-word or atomic; `instanceIndex` with an `i ≥ N` guard (three splits dispatches > 65,535).
- Hidden/deleted points collapse the quad (`sizeNode = 0`), never a huge position. Anything derived from the point index inside `colorNode` goes through `vertexStage()`.
- `src/viewer/` stays self-contained (CSS modules, `--pcv-*` tokens over Lab names, keys on the viewer root only).
- vitest runs in node: unit tests import pure modules only; DOM/WebGPU is verified in the browser.
- StrictMode stays on; the renderer factory is idempotent per canvas (see ARCHITECTURE "Renderer factory under StrictMode").

## Data
- Source: City of Vancouver LiDAR 2022 tile `491000_5458000` (OGL – Vancouver, attribution required). Not 3DEP (A10).
- `npm run data:demo` / `data:full` → `public/data/{demo,full}/` (gitignored) from release `v0.1-data`. Release assets have **no CORS**; the viewer loads same-origin. Cross-origin hosting for the Lab embed is undecided (Phase 6).
- Rebuild: `tools/.venv` (`pip install -r tools/requirements.txt`), tile zip downloaded in a browser (Cloudflare challenge; Chrome MCP was not connected last time), `tools/fetch.py --import`, `tools/preprocess.py … --max-points 20000000 --demo 2000000`. Raw `.las` lives in `data/raw/` (gitignored, may be deleted).

## Environment
- M4 Max, Chromium via Playwright MCP, DPR 1. Vsync cap 240 Hz (4.17 ms floor). Playwright console buffer caps ~184 entries; don't poll the page in tight external loops while 160 MB streams (tab crashes) — use one in-page loop or `browser_wait_for`.
- Chrome MCP extension is optional; if unavailable ask the user to download by hand.
