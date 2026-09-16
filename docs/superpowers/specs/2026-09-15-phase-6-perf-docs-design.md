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
  compute(): Promise<{ hashMs, normalsMs, aoMs }>;   // GPU timestamps
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
