# Phase 6: Perf & Docs — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §5, §7.6

## Goal

Produce reproducible performance numbers for the finished viewer, and ship the public-facing docs: README with media and perf tables, final ARCHITECTURE, and Lab embedding notes. Every number in the README traces to a runbook step anyone can re-run.

## Scope

In: bench handle + runbook, measurement runs at 2M / 10M / 20M, README rewrite, `docs/media/` (PNG + webm), `docs/ARCHITECTURE.md` final, `docs/EMBEDDING.md`, portfolio blurb.
Out: new viewer features, optimisation work (a regression found here becomes a separate bounded task), Lab-side integration commit (that happens in the Lab repo).

## Interfaces

### Bench handle
`?bench=1` on the viewer URL exposes `window.__pcv` (only then; never in the embedded build):
```ts
{ loadedFraction(): number; frame(): { ms: number; fps: number; draws: number };
  orbit(steps = 20, ms = 2000): Promise<void>;      // scripted camera orbit around target, controls.update() per step
  setBudget(frac: number): void;                     // 0–1, drives point-budget slider
  compute(): Promise<{ countMs, scanMs, scatterMs, normalsMs, aoMs, totalMs }>;   // GPU timestamps, one per Phase 4 pass
  cpuBench(n = 2_000_000): Promise<{ normalsMs, aoMs }>;
  verify(): Promise<{ medianDeg, maxDeg, aoMae }>;
  lasso(polyPx: [number, number][]): Promise<{ gpuMs, readbackMs, selected }>;
  pick(x: number, y: number): Promise<{ ms, index }>;
  edl(on: boolean): void;
  memory(): { computedBytes: number }; }             // pos + flags + normals + AO + hash tables
```
Thin wrappers over the store and existing phase 3–5 APIs; no new measurement code paths.

### Runbook `scripts/bench.md`
Playwright MCP steps, no human in the loop. Each row: navigate, wait `loadedFraction() === 1`, settle 3–5 s, read. Records machine, macOS, Chromium version, DPR, headless/headed, date.
| Dataset | Rows measured |
|---|---|
| demo (2M) | load time, frame ms/fps default → post-orbit, draws, computed GPU MiB + GPU-process RSS delta, normals + AO GPU ms vs CPU ms, verify (median/max deg, AO MAE), lasso GPU ms + flags readback ms, pick latency, EDL on/off frame delta |
| full @ 50% budget (10M) | load time, frame ms/fps default → post-orbit, draws, memory, normals + AO GPU ms, lasso ms, EDL delta |
| full @ 100% (20M) | same as 10M |
Load time = manifest fetch start → `loadedFraction() === 1`, localhost `vite preview` serving `public/data/`. GPU-process RSS via `ps -eo rss,command | grep type=gpu-process` before/after, as in phase 0.

### README (final structure)
1. Hero: `docs/media/hero.webm` (fallback GIF/PNG link) 2. What it is (3 lines) + portfolio blurb (3–5 sentences) 3. Controls table (mouse, keys, panel) 4. Setup (`npm install`, `npm run data:demo`, `npm run dev`; WebGPU requirement) 5. Data (source tile, licence, preprocess pointer, `data:full`) 6. Perf table (machine, Chromium, DPR, headless/headed noted; rows per runbook) 7. Memory budget table (measured, replaces the spec's estimates) 8. Architecture summary (5 bullets + link) 9. Licence + USGS 3DEP attribution.

### Media `docs/media/`
`hero.webm` 10–15 s (load → orbit → lasso → split → EDL toggle), 3–5 PNGs (overview, classification colormap, normals + AO, lasso selection, split). Captured with Playwright video / screenshots at 1280×720, DPR 1. Total ≤ 5 MB (re-encode webm with ffmpeg if over).

### `docs/ARCHITECTURE.md` (final)
ASCII data-flow diagram (LAZ → preprocess → release → loader worker → GPU buffers → render / compute / edit → export), point + manifest format, loader (queue, Range, fallback), render (global qpos buffer, per-chunk sprites, flags, colormaps, EDL), compute pipeline (hash → scan → scatter → normals → AO, sizing, timing), editing/undo model (flags mirror, dirty range, ring), per-phase findings sections kept verbatim.

### `docs/EMBEDDING.md`
Copy `src/viewer/` into the Lab experiment folder; exact deps (`three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `fflate@<pinned>`, `.npmrc` note); `<PointCloudViewer manifestUrl theme? className? />` props; theme tokens consumed with fallbacks: `--bg`, `--bg-surface`, `--bg-card`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border`, `--accent`, `--font-body`, `--font-mono`, `--radius`; data URL configuration (release URL vs Lab-hosted); WebGPU-unsupported message behaviour; keyboard focus scoping.

## Acceptance criteria

- Every number in the README perf and memory tables maps to a runbook step and a dated run; a re-run reproduces within ±10%.
- `docs/media/` ≤ 5 MB total, hero webm plays in Chrome and Safari (VP9 or H.264 fallback noted).
- `npm run build` clean; `npm test` and pytest green; no `__pcv` outside `?bench=1`.
- ARCHITECTURE matches the merged code (file names, buffer names, pass names checked by grep).
- EMBEDDING verified: `src/viewer/` copied into a scratch Vite + React app in the scratchpad, deps installed per the doc, `vite build` passes, demo manifest renders (spike step, scratch app not committed).

## Risks and spikes

- **Playwright video unavailable in the MCP setup** → fall back to a PNG frame sequence + ffmpeg, or a screen recording of the headed browser; note the method in the runbook.
- **Headless vs headed GPU numbers differ** → measure both for the 2M row; publish headed, keep headless in the runbook.
- **20M run exceeds headless memory or times out** → raise Playwright timeouts; if the tab dies, record 10M as the top row and say why.

## Tests

No new automated tests. Existing vitest + pytest suites must stay green. The acceptance test for this phase is the runbook reproducing the README numbers within ±10%.

## Docs

This phase *is* the docs: README, ARCHITECTURE, EMBEDDING, media. Master spec status line updated to "complete"; phase list marked done.

## Amendments (2026-09-25, before the plan)

Decisions taken with the spec-review items 1–18 (`2026-09-17-spec-review-phases-3-6.md` § Phase 6) in front of us. These win over the sections above.

- **P6-1 Lab integration = standalone deploy + proxy, not a folder copy.** This repo deploys as its own Vercel project (Hobby) with `base: '/point-cloud/app/'`; the Lab's `vercel.json` proxies `/point-cloud/app/*` to it (same pattern as the Lab's existing `/bfl-api/*` route) and a Lab route page `/point-cloud` renders `LabHeader` + a full-height iframe. Proxied = same-origin to `lab.merttoka.com`: no CORS, no dependency coupling, pinned deps untouched. Theme: `?theme=` on first load, `postMessage({ type: 'pcv-theme', theme })` from the Lab page afterwards (same-origin check). The Lab-side commit lives in the Lab repo (`/Users/toka/Professional/Public/website/lab`), made in this phase but pushed only on the user's say-so.
- **P6-2 Data hosting.** Both datasets are fetched at Vercel build time (`npm run data:demo && npm run data:full` before `vite build`; Vercel has no output-file size limit, the 100 MB figure is CLI source uploads). Demo is the default; the full set stays opt-in via `?data=full` (160 MB per load against the Hobby 100 GB/month). `check_hosting.py` gains `--no-cors` (same-origin use) and must PASS `range 206` against both the project URL and the Lab-proxied URL; if the proxy drops `Range`, the loader's single-fetch fallback carries it and the runbook records that.
- **P6-3 Bench handle via prop, not URL parsing in the viewer.** `PointCloudViewer` gets `onApi?: (h: BenchHandle) => void`; the harness (`src/App.tsx`) attaches `window.__pcv = h` when `?bench=1`. `src/viewer/` parses no URL and sets no global; acceptance grep: zero `import.meta.env.DEV` and zero `__pcv` under `src/viewer`. The handle is allowed on the production harness (it is inert unless asked for).
- **P6-4 Handle shape** (supersedes § Bench handle; drift 9–14 applied): `loadedFraction`, `loadMs`, `uploadMs`, `frame` (ms/fps/draws + width/height/dpr), `renderGpuMs` (render-pass timestamp query, resolves the EDL Deferred item), `orbit`, `setBudget`, `edl`, `shading`, `compute` (per-pass gpu + wall), `cpuBench()` (no `n` argument), `verify()` (demo-only), `classStats`, `lasso` (+ `selected`), `pick` (ms + resulting selected count; index is applied by the editor, not returned), `cpuPick`/`cpuLasso` (CPU references), `editor`, `memory()` (computed bytes with breakdown; ≈394 MB at 20M after a build), `record(seconds)`, `runAll(opts)` (one in-page run producing a JSON row), `state()`.
- **P6-5 One in-page `runAll` per dataset, dated JSON rows.** The runbook is one `browser_evaluate` per dataset (no external polling while 160 MB streams); results are committed as `docs/bench/<date>-<machine>.json`, and every README number cites a row by file + key. Headless Chromium (Playwright MCP) is the published configuration, consistent with every earlier number; a headed run is optional and, if made, recorded alongside.
- **P6-6 Hero via `canvas.captureStream()` + `MediaRecorder`** (`record(seconds)`), downloaded as webm; `ffmpeg` (8.1.2, installed) trims/re-encodes to ≤ 3 MB VP9 and writes an H.264 `hero.mp4` fallback for Safari. PNG sequence + ffmpeg stays the fallback if MediaRecorder is unavailable in headless.
- **P6-7 EMBEDDING spike targets the Lab's actual toolchain**: Vite 7.3.1, React 19.2.4, TypeScript 5.9.3 with `strict: false`, `tsc -b`, no `.npmrc` (React 19.2.4 satisfies fiber 9.7.0's `>=19 <19.3`; the doc tells embedders to pin). Scratch app in the scratchpad, not committed.
- **P6-8 README**: drop the per-phase Status section (ARCHITECTURE holds the findings), attribution is the Open Government Licence – Vancouver line (drift 1), add the Lab URL, `?bench=1` and `?data=full` usage.
- **P6-9 Dev-server base**: `base` is `/point-cloud/app/` in dev, preview and build alike (one URL shape everywhere): `http://localhost:5173/point-cloud/app/`. README, CLAUDE.md and the runbook use it.
- **P6-10 Out of scope stays out**: no single-encoder compute rewrite, no renderer disposal work; both stay in Deferred with owner "any".
