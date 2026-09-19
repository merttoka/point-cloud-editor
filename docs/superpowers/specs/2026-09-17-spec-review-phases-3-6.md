# Spec review: phases 3–6 vs shipped phases 1–2

Date: 2026-09-17
Status: review notes — proposed amendments, not yet applied to the phase specs. Resolve each item when writing that phase's plan (apply the amendment to the spec, or record a ruling in the plan).
Basis: main at `13beff4` (phase 2 + deslop), `docs/ARCHITECTURE.md`, the Phase 1–2 SDD rulings.

## What changed underneath the specs

The four specs were written before phases 1–2 shipped. Shipped shapes they depend on:

| Spec assumption | Shipped |
|---|---|
| `fitDistance(manifest, fov)` / camera options object on `<Canvas>` | `homePose(manifest, fov) → { dist, pos }` in `render/Scene.tsx`; `<Canvas camera={instance} scene={instance}>` with stable `useMemo` instances (StrictMode fix); renderer cached per canvas in a `WeakMap` |
| `Scene.tsx` writes material uniforms on store change | `ChunkSprites` subscribes to the store and calls `handle.setPointSize/setMode/setLut`; sprite `count`s are written inside the store notification (no React render per chunk) |
| `dqMin` / `dqScale` uniforms "already used by the vertex stage" | Private to `createPointMaterial`'s closure (`dqScale`, `dqMinCentred`); `PointMaterialHandle` exposes only setters |
| `useLoader(store, url)` / `createPointMaterial(buffers, manifest, centroid)` | `useLoader(manifestUrl, api)` (store from context); `createPointMaterial(buffers, manifest, init: Pick<ViewerState, 'pointSize'|'colorMode'|'colormap'>)`; `centroidOf` lives in `loader/manifest.ts` |
| Worker protocol `start | camera | dispose` | Same plus `start.pos` (queue seeded with the home pose) and `io.totalBytes` (full-fetch length check); one retry per chunk; worker stays alive after `done` (terminated on unmount) |
| Flags buffer `u32[ceil(N/4)]` | `PointBuffers.flags` (`StorageBufferAttribute`, `flagsNode = storage(flags, 'uint', flagWords)`); no CPU `Uint8Array` mirror yet; `uploadRange` exists for `qpos` only |
| Renderer factory: no backend reads except `compatibilityMode` | `DatasetLimitCheck` also reads `backend.device.limits.maxStorageBufferBindingSize` (deslop) — see Deferred |
| HUD `draws` at 100 % = chunks + 1 | Confirmed 257 = 256 sprites + output blit |
| Baseline frame times | 2M: 4.17 ms (vsync-capped 240 Hz); 20M @ 2 px: 32.8 ms / 30 fps; 20M @ 50 %: 17.6 ms |
| Data source | City of Vancouver LiDAR 2022 (A10), OGL – Vancouver; **not** USGS 3DEP |

## Phase 3 — EDL

**Applied 2026-09-17 (plan)** — see `docs/superpowers/plans/2026-09-17-phase-3-edl.md` "Rulings on the spec-review items" for how each item below was resolved, and `docs/superpowers/specs/2026-09-15-phase-3-edl-design.md` / `docs/ARCHITECTURE.md` § Post-processing (phase 3) for the shipped result.

1. **`Scene.tsx` handover**: the pipeline should be built in a child of `<Canvas>` (`useThree().gl/scene/camera` are the stable instances now) and memoised per `gl`; `useFrame(() => pipeline.render(), 1)` as specced. Under StrictMode the priority subscription is added/removed twice — r3f balances it, but verify `internal.priority` returns to 0 on unmount (spike step).
2. **Uniform wiring**: "Values live in the viewer store; `Scene.tsx` writes the uniforms on change" → follow the shipped pattern: the pipeline component subscribes to the store (like `ChunkSprites`), no prop plumbing through `Scene`. Store gains `edl: { enabled, radiusPx, strength }` with defaults `true / 1.5 / 1`.
3. **Baseline size**: acceptance says "20M, DPR 1, **size 3 px**"; every shipped 20M number is at **2 px**. Amend to 2 px so EDL on/off deltas compare against the recorded rows, or add a 3 px row to both.
4. **Toggle-off equivalence** is stated twice with different tolerances ("bit-for-bit" in Interfaces, "within 1/255" in Acceptance). Keep 1/255 (HalfFloat intermediate + one output transform); drop "bit-for-bit".
5. **`draws` with the pipeline**: spec expects chunks + 2. With `RenderPipeline` rendering the output quad straight to the canvas, three's own `_renderOutput` blit may no longer run (it exists for canvas renders only). Record whatever the HUD shows (256 + 1 or + 2); the acceptance line already says "document, do not fix" — reword to not pre-commit to + 2.
6. **Near/far**: `CameraRig.fit` sets `near = d/1000`, `far = d×10` (d ≈ 1.6 km on the full tile → near 1.6 m, far 16 km). The background rule `-viewZ ≥ far×0.999` and `log2(max(-viewZ, near))` use these; read them from the camera each frame as specced (they change on `F`).
7. **Resize**: the Task 8b bug (300×150 depth buffer) was a factory duplication, not a resize path issue; the resize spike in Risks stays valid for the pass target.
8. **Renderer leak**: the `RenderPipeline` and pass targets join the un-disposed renderer (Deferred). Dispose the pipeline on unmount anyway so the fix is local when r3f/three lifetime is solved.
9. Panel group naming: shipped Panel has no groups yet; "Lighting" is the first — pick a `.group` CSS module class that Phase 4/5 reuse (Compute, Editing).

## Phase 4 — Compute

**Applied 2026-09-18 (plan)** — see `docs/superpowers/plans/2026-09-18-phase-4-compute.md` "Rulings on the spec-review items" for how each item below was resolved, and `docs/superpowers/specs/2026-09-15-phase-4-compute-design.md` § Plan rulings / `docs/ARCHITECTURE.md` § Compute (phase 4) for the shipped result.

1. **Dequant uniforms**: expose `dqScale` / `dqMinCentred` (and the centroid) from `PointBuffers` or a small `render/dequant.ts` so material, compute kernels and Phase 5 pick share one set. Today they are closure-private in `createPointMaterial`.
2. **Where `normals`/`ao` live**: the vertex stage reads them for lit modes, but the material is created at manifest time (before any build). Options: (a) allocate `normals` (`u32[N]`, 80 MB) and `ao` (`u32[ceil(N/4)]`, 20 MB) zero-filled in `createPointBuffers` — simplest, +100 MB GPU up front at 20M (memory table becomes ~272 MB before the hash build; total unchanged after); (b) create the material lazily / rebuild it after the first build. Recommend (a); amend the memory table and note that lit modes before a build read zeros (= `+Z`, ao 1 if encoded as 255) — pick encodings so zero-filled buffers render sanely, or gate lit modes on `built === true` as the spec already does.
3. **Inputs section**: "hidden/deleted are not excluded" — fine, but note `flags` is also what Phase 5 writes; compute reads only.
4. **Worker reuse for the CPU bench**: the loader worker stays alive after `done` and `LoaderIn` is a discriminated union — add `cpuBench` / `cancel` / `export` (Phase 5) variants there rather than a second worker. `api.sendCamera` is cleared on `done`, so no camera traffic competes with the bench.
5. **Build gating**: "enabled once load is 100 %" → `status === 'ready'` (set on worker `done`). Note the Deferred item: after a post-load chunk error `status` stays `'loading'`, which correctly keeps the button disabled.
6. **Zeroing atomics buffers**: with `updateRanges` semantics, writing zeros into the array + `needsUpdate` without an update range triggers a full upload — correct but 16.8 MB per build at T = 2²²; fine, just say so.
7. **Timing**: `trackTimestamp: true` and `resolveTimestampsAsync` are already in the factory/phase-0 findings; HUD `info.reset()` runs every frame (`autoReset = false`) — `info.compute.timestamp` must be read before the HUD resets it, or read the promise result only (spec already does the latter).
8. **Limits**: `maxStorageBufferBindingSize` is requested at the adapter max (~4 GiB on M4 Max); the 80 MB `sorted`/`normals` buffers fit the default `maxBufferSize` (256 MiB). No change needed; the 20M acceptance line can cite this.
9. **Spacing estimate** `sqrt(areaXY / N)` assumes N = full count; at budget < 100 % the compute still runs over all N (budget is a render prefix) — state that explicitly.
10. **Register pressure fallback** (k = 12) and hash-collision cost are unchanged; the demo tile is dense downtown (Building 47.6 %), so collision rate is worth recording.

## Phase 5 — Editing

**Applied 2026-09-19 (plan)** — see `docs/superpowers/plans/2026-09-19-phase-5-editing.md` "Rulings on the spec-review items" for items 1–10 below plus the further drift found on re-check (items 11–20 there).

1. **Flags mirror**: make the CPU mirror a `Uint8Array` **view** over `flags.array.buffer` (little-endian, byte i = point i) instead of a second 20 MB array; then "upload `[minIdx, maxIdx]`" is a word-aligned `flags.addUpdateRange(minIdx >> 2, ((maxIdx >> 2) - (minIdx >> 2)) + 1)` + `needsUpdate`. Add `PointBuffers.uploadFlagsRange(minIdx, maxIdx)` next to `uploadRange`. Undo `prevFlags` slices copy from the same view.
2. **Keyboard conflict**: `H` is "toggle HUD" since Phase 2 (README Controls). Phase 5 assigns `H` = hide. Amend: hide → `X` (or move HUD toggle to `Shift+H`). Existing keys: `F` fit, `H` HUD.
3. **Pick radius** `max(3 px, pointSize)`: rendered size is `clamp(pointSize × refDist / −z, 1, 8)` px, so on-screen dots are usually smaller than `pointSize` at the home pose. Either use the same attenuated size in the kernel (needs `refDist`, already a uniform) or keep the CSS-px rule and say picks are generous. Recommend the attenuated size, capped ≥ 3 px.
4. **Dequant + viewProj**: reuse the shared dequant uniforms (Phase 4 item 1); positions are centred at the bounds centroid, target at origin — matches.
5. **Selected/split colours in the material**: `colorNode` samples the LUT; the override must be `select(flag, tint, lut)` with the flag byte derived in the vertex stage (it already is: `fbyte`) — wrap the selector in `vertexStage()` per the Phase 2 rule.
6. **Lasso vs OrbitControls**: `OrbitControls makeDefault` owns pointer events on the canvas; in lasso mode set `useThree().controls.enabled = false` and let `LassoOverlay` (above the canvas, `pointer-events` only in lasso mode) capture. State the `controls` handle comes from r3f's `makeDefault`.
7. **Export re-open**: "pointing `manifestUrl` at the extracted manifest" implies a dataset switch on a mounted viewer → hits the Deferred renderer/`<Scene key>` items. Either add `key={manifestUrl}` on `<Scene>` in this phase or scope re-open to a fresh page load; the acceptance line should say which.
8. **Worker messages**: `export` joins the `LoaderIn` union (see Phase 4 item 4); `words: qpos.array.slice()` transfer at 20M is 160 MB — the spec's peak-memory note stands.
9. **Full flags readback** (A5) via `renderer.getArrayBufferAsync(flags)` — phase 0 note: it throws if the attribute was never bound by a pipeline; the vertex stage binds it every frame, so fine after first render.
10. **Shortcut scoping**: shipped root uses `onKeyDown` with `tabIndex=0`, which already implies focus inside the root; the extra `root.contains(document.activeElement)` check is redundant unless handlers move to `window` (they must not).

## Phase 6 — Perf & docs

**Re-checked 2026-09-19** against main `eb9a4a2` (phases 3, 4, 4b shipped). Items 1–8 below stand; additions:

9. **Dev globals to fold into `window.__pcv`**: `__pcvUploadMs` (Phase 2), `__pcvCompute { build, readback, tableSize, timings, state, cpuCellStart, classStats }` and `__pcvBench { state, run }` (Phase 4), `__pcvEdit` (Phase 5). All are `import.meta.env.DEV`-gated today; Phase 6 moves them behind `?bench=1` and deletes the ad-hoc names. `classStats`/`cpuCellStart` are measurement hooks and may stay on the handle.
10. **`compute()` shape**: shipped rows are `count / scan / scatter / normals / ao` (`PassTiming[]`, `gpuMs | null`) plus `elapsedMs` wall; the handle should return `{ countMs, scanMs, scatterMs, normalsMs, aoMs, totalMs, wallMs }` and the README must cite `gpu`, not wall (ARCHITECTURE § Timing semantics).
11. **`cpuBench(n)`**: the shipped bench caps at `BENCH_CAP` and on the full set runs a per-chunk prefix subsample (1,999,872 pts) — `n` is not a free parameter. Handle signature becomes `cpuBench(): Promise<{ hashMs, normalsMs, aoMs, n }>`; `verify()` is demo-only (same point set rule).
12. **`frame()`**: the HUD EMA lives in a ref inside `ui/Hud.tsx`; expose it via `api.frame = () => ({ ms, fps, draws })` written by `Hud` so the handle needs no DOM read (also resolves the `id="hud"` Deferred item — switch to `data-pcv-hud`).
13. **`orbit()`** needs the `OrbitControls` instance: `CameraRig` holds it in a ref — add `api.orbit(steps, ms)` there.
14. **`memory()`**: computed bytes = `qpos` + `flags` + `normals` + `ao` + hash (`cellStart`, `cellCursor`, `blockSums`, `sorted`) + Phase 5's `pick`/`polygon`/`chunkTable` (KB) — 394 MB at 20M after a build (ARCHITECTURE § Memory). Two columns as before (computed vs GPU-process RSS proxy).
15. **Perf rows already measured**: EDL on/off (Phase 3), normals/AO GPU vs CPU and verify (Phase 4/4b), lasso/pick (Phase 5) — Phase 6 re-runs them in one dated session from the runbook rather than copying README numbers forward.
16. **EMBEDDING**: `dpr?: number` prop exists (Phase 3); token list in the spec matches `theme/tokens.module.css`; `fflate` pin = `0.8.3` (Phase 5); `.npmrc` `legacy-peer-deps` note stands.
17. **Media**: no video tool in Playwright MCP (item 7) — decide whether `ffmpeg` is on the machine before planning the webm; else PNG hero + GIF.
18. **Hosting** (item 2) is still undecided and blocks `EMBEDDING.md`'s data-URL section — must be settled before the Phase 6 plan.

1. **Attribution**: README item 9 says "USGS 3DEP attribution" — wrong since A10. Must be "Contains information licensed under the Open Government Licence – Vancouver" (already in README Data). Amend.
2. **Hosting decision is a prerequisite**: `EMBEDDING.md` "data URL configuration (release URL vs Lab-hosted)" — the release URL cannot be used from a browser (no CORS). Options recorded in Deferred: website static (`.htaccess` CORS; demo via git-ftp, full via manual FTP — 160 MB exceeds the git-repo limit) or a bucket. Decide before writing the doc.
3. **Bench handle vs dev globals**: Phase 2 exposes `window.__pcvUploadMs` under `import.meta.env.DEV`; fold it into `window.__pcv` behind `?bench=1` and delete the ad-hoc global. Also replace `id="hud"` with `data-pcv-hud` (Deferred) so `frame()` reads the HUD without a global id.
4. **Load time definition**: Phase 2 measured 363 ms (2M) / < 400 ms (20M) on the Vite dev server; the runbook says `vite preview`. Keep `vite preview` but note the dev-server numbers as the Phase 2 baseline.
5. **Rows depend on phases 3–5** (EDL delta, normals/AO, lasso, pick, verify); the runbook table is fine, but Phase 6 must also re-measure the Phase 2 rows (2M/10M/20M frame) with EDL on and off since the frame path changes in Phase 3.
6. **Memory table**: Phase 2's computed numbers (160 + 20 MB GPU, same CPU) plus Phase 4's ~214 MB; keep "computed buffers" vs "GPU-process RSS proxy" as two columns (phase 0 convention).
7. **Media**: Playwright MCP has no video tool; plan on the PNG-sequence + ffmpeg fallback from the start.
8. **Master spec status**: items 0–2 already "Done."; the final pass marks 3–6 and the status line.

## Cross-cutting

- `docs/ARCHITECTURE.md ## Deferred` is the backlog; each phase's plan should triage the items it touches.
- The three 0.186 kernel rules and the `vertexStage` rule are in `CLAUDE.md`; specs need not repeat them.
- All shipped 20M numbers are at 2 px, DPR 1, headless Chromium — keep that configuration for deltas.
