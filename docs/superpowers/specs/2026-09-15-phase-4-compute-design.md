# Phase 4: Compute — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §3, §7.4 (amendments A3 global `qpos` buffer, A4 hash sizing, A9 dispatch apply)

## Goal

Per-point normals and ambient occlusion computed on the GPU in raw WGSL over all loaded points, with per-pass GPU timing shown in the panel, three shading modes that consume the results, and a CPU implementation of the same algorithms used only as a benchmark and correctness oracle.

## Scope

In: spatial hash build (count, scan, scatter), normals pass, AO pass, `pipeline.ts` orchestration + timing table, shading modes (flat / normal-lit / lit + AO), CPU benchmark in the loader worker, Verify button, vitest for CPU algorithms, ARCHITECTURE compute section.
Out: LOD, incremental recompute on edit (results are frozen after build; hidden/deleted points keep their normal/AO), per-chunk compute, WebGL fallback, AO with multiple bounces, curvature or other per-point features.

## Interfaces

### Layout
```
src/viewer/compute/
  hash.wgsl.ts       # count, scan (3 kernels), scatter
  normals.wgsl.ts    # kNN + covariance + Jacobi + oct-encode
  ao.wgsl.ts         # thread-per-word AO
  pipeline.ts        # buffer allocation, dispatch order, readback helpers
  timing.ts          # resolveTimestampsAsync per pass → { pass, submitMs, gpuMs }
  cpu/hash.ts        # same grid + kNN in TS typed arrays
  cpu/normals.ts
  cpu/ao.ts
```
Kernels are `wgslFn` strings with `ptr<storage, array<T>, read_write>` params; each kernel **returns a `u32` and the call is `.toVar()`-ed** (three 0.186 drops void `wgslFn` calls, see ARCHITECTURE.md). Storage params are passed as a named object; index = `instanceIndex`.

### Inputs (from Phase 2)
- `qpos`: global `StorageBufferAttribute` `Uint32Array(N × 2)` (A3). Positions dequantized inside kernels with the `dqMin` / `dqScale` uniforms already used by the vertex stage.
- `flags`: global `u32[ceil(N/4)]`; hidden/deleted points are **not** excluded from neighbourhoods (build is geometry-only).
- Manifest `bounds`, `pointCount`.

### Parameters
- `radius` (metres). Default `3 × spacing`, `spacing = sqrt((maxX − minX) × (maxY − minY) / N)`. Slider `1–6 × spacing`; changing it invalidates results (button re-enabled).
- `k = 16` neighbours, `eps = 0.02 × radius` for the AO tangent-plane test. Both constants, not UI.

### Buffers (T = `nextPow2(max(1024, N / 8))`)
| buffer | type | 20M (T = 2^22) |
|---|---|---|
| `cellStart` | `u32[T + 1]` | 16.8 MB |
| `cellCursor` | `u32[T]` | 16.8 MB |
| `sorted` | `u32[N]` (point indices grouped by cell) | 80 MB |
| `normals` | `u32[N]` (oct-encoded, 2 × u16) | 80 MB |
| `ao` | `u32[ceil(N/4)]` (u8 packed) | 20 MB |
| **added** | | **~214 MB** |
| total GPU incl. `qpos` + `flags` (171.7 MiB) | | **~380 MB** |

`cellStart`/`cellCursor` are freed after the build; `sorted` is kept until the next build (AO re-runs on radius change without a rebuild only if radius is unchanged — otherwise full rebuild).

### Passes (dispatched in order by `pipeline.ts`, one `computeAsync` each, timestamp per pass)
1. **count** — thread per point: `cell = floor((p − bounds.min) / radius)`, `key = hash(cx, cy, cz) & (T − 1)` (`hash = cx × 73856093 ^ cy × 19349663 ^ cz × 83492791`), `atomicAdd(cellStart[key], 1)`. Collisions merge cells; the neighbour distance test filters the extra candidates.
2. **scan** — exclusive prefix sum over `cellStart[0..T]`, three kernels (reduce-then-scan): block reduce (workgroup 256, one `u32` sum per block into `blockSums`), scan of `blockSums` (single workgroup, T/256 ≤ 16384 entries → looped), then per-block local exclusive scan seeded with the scanned block sum, written in place. The third kernel also writes `cellCursor[c] = cellStart[c]` (three has no public buffer-copy API). Result: `cellStart[c]` = first index of cell `c` in `sorted`, `cellStart[T]` = N.
3. **scatter** — thread per point: `sorted[atomicAdd(cellCursor[key], 1)] = i`.
4. **normals** — thread per point: visit the 27 cells around `p`, iterate `sorted[cellStart[c] .. cellStart[c+1])`, keep the `k` nearest within `radius` by register insertion sort (arrays of 16 `f32` + 16 `u32`), covariance of the kept neighbours, smallest eigenvector via Jacobi 3×3 (fixed 8 sweeps), orient toward +Z, oct-encode to `2 × u16` → `normals[i]`. Degenerate (< 3 neighbours, or smallest two eigenvalues equal within 1e-6) → `+Z`. The camera-facing flip (`dot(n, viewDir) < 0`) is done in the vertex shader, not stored.
5. **ao** — thread per **word** (4 points): for each of the 4 points, decode `n`, count neighbours within `radius` with `dot(p_j − p, n) > eps`, `ao = 1 − count / total` (0 neighbours → 1), pack u8 → whole-word store `ao[w]`.

Dispatch shape: workgroup size 64 for point-parallel kernels, `Fn(...)().compute(N, [64])`. At 20M that is 312,500 workgroups, above the 65,535 per-dimension limit; three 0.186 handles this itself (A9): `WebGPUBackend.compute` clamps X to 65,535 and adds a Y dimension for a numeric count, and the compute prologue defines `instanceIndex = globalId.x + globalId.y × (wgX × numWorkgroups.x) + …`, so kernels keep using `instanceIndex` with an `i ≥ N` guard (three also emits an early return from `count` when `allowEarlyReturns` is on). No hand-rolled 2D indexing. Scan kernels use workgroup 256. Buffers written by atomics (`cellStart`) are zeroed before each build by writing zeros into the attribute array and flagging `needsUpdate`.

### Timing
`timing.ts` wraps each pass: `t0 = performance.now(); await renderer.computeAsync(node); submitMs = performance.now() − t0; gpuMs = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)`. "submit" is CPU encode + submit (does not await GPU completion); "gpu" is the timestamp delta (Metal quantises to ~0.066 ms). Falls back to `n/a` when `timestamp-query` is unavailable. Panel table rows: count, scan, scatter, normals, ao, **total**.

### UI
- "Build normals + AO" button, enabled once load is 100% (compute needs every point present; partial builds would seam). Disabled while running; shows elapsed.
- Shading select: `flat` (colormap only), `normal-lit` (Lambert with a headlight: `max(dot(n', viewDir), 0.15)` × colormap, `n'` = camera-facing-flipped normal), `lit + AO` (× `ao`). Modes other than `flat` are disabled until a build has completed.
- CPU benchmark section (debug panel): N cap 2M (demo set, or first-N prefix of each chunk on the full set), Run / Cancel, progress %, table `pass × { GPU ms, CPU ms, N }`.
- Verify button: runs GPU and CPU at the same N, reads back `normals` and `ao` with `renderer.getArrayBufferAsync`, reports median + max angular difference (degrees) and AO mean absolute error.

### CPU path (`compute/cpu/`, runs in the loader worker)
The worker holds no copy of `qpos` (A6): on Run, the main thread posts `{ type: 'cpuBench', words: qpos.array.slice(0, n * 2), n }` (≤ 16 MB at the 2M cap, buffer transferred). Same grid, kNN, Jacobi and AO in TS over typed arrays; `postMessage` progress every 100k points; cancel is message-checked between 100k-point work slices. Benchmark only, never a rendering path.

## Acceptance criteria

- 2M (demo): all five passes complete, GPU total reported in the panel (target < 200 ms, actual recorded in README).
- 20M (full): build completes without validation errors within the `maxStorageBufferBindingSize` already requested in Phase 0/2; memory stays within the table above.
- Verify at 2M: median angular difference < 1°, max reported; AO MAE reported; zero NaN normals (checked in the readback).
- Shading modes visibly change the image; lit modes show no seams at chunk borders (compute is global).
- No console errors; `resolveTimestampsAsync` returns nonzero per pass on the target machine.

## Risks and spikes

- **Atomics through TSL**: `storage(attr, 'uint', T).toAtomic()` declares the buffer struct as `value: array<atomic<u32>>` (`WGSLNodeBuilder`, `isAtomic`), so the `wgslFn` param must be `ptr<storage, array<atomic<u32>>, read_write>` and the kernel calls `atomicAdd(&cellStart[key], 1u)` — spike first in the plan: a 1k-point count kernel, read back, compare to a CPU histogram. Fallback: TSL `atomicAdd(...)` node from `three/tsl` instead of raw WGSL for the two atomic kernels.
- **Scan correctness** at T up to 2^22: vitest the CPU reference; GPU spike compares `cellStart` readback against it at T = 2^16 and 2^22.
- **Dispatch limits**: handled by three (A9); the spike verifies a 20M-thread kernel writes every index (readback of a `touched[N/4]` word buffer, all bits set).
- **Readback size**: 80 MB `normals` + 20 MB `ao` via `getArrayBufferAsync` for Verify — only at the 2M cap (8 MB + 0.5 MB); never at 20M.
- **Register pressure** in the normals kernel (32 registers for kNN + 3×3 Jacobi): if the compiler spills badly, reduce k to 12 (documented as a tunable).
- **Hash collisions on dense tiles**: merged cells inflate candidate counts; the distance test keeps results correct, cost only.

## Tests

- vitest (`compute/cpu/*.test.ts`): grid + kNN vs brute force on 10k random points (identical neighbour sets); Jacobi on known symmetric matrices (eigenvalues/vectors within 1e-5); oct encode/decode round-trip (max angular error < 0.5°); exclusive scan on random arrays vs `reduce`; AO on a synthetic plane (≈1) and a synthetic corner (< 0.6).
- Playwright smoke: load demo, click Build, read the panel table via `browser_evaluate`, assert five nonzero rows, switch shading modes, screenshot.

## Docs

ARCHITECTURE: compute pipeline (buffers, pass order, hash sizing rationale, dispatch shape, timing semantics, CPU-verify method). README: perf table rows for normals + AO GPU vs CPU @2M.
