# Phase 4b: Normal Quality & Lighting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lit` / `lit + AO` shading read as solid geometry: facade normals stop speckling (PCA over the full radius neighbourhood at 6 × spacing), and the lighting model stops blackening side walls (wrap + fixed sun, AO as a shade not a mask).

**Architecture:** The normals kernel drops the K = 16 register kNN and accumulates a single-pass covariance of `d = p_j − p_i` over every neighbour within `radius` (centred on the point, so f32 stays exact for |d| ≤ r); the default radius rises to 6 × spacing (a smoothing pass was planned and ruled out after measuring — see Task 2). The CPU mirror follows the same estimator so Verify stays meaningful. The material's `light` term becomes `ambient + wrap·|n·v| + sun·max(n·L, 0)` with `ao` applied as `sqrt(ao)`; a `normals` debug shading mode paints `|n|` so the fix is visible and measurable (class-wise `|n.z|` histogram via the DEV hook).

**Tech Stack:** as Phase 4 (three 0.186 `wgslFn` + `storage()`, R3F 9.7, vitest, Playwright MCP).

**Spec:** `docs/superpowers/specs/2026-09-15-phase-4-compute-design.md` — this plan amends it (see "Spec amendment" below; recorded as **A11** in the master spec's Amendments list). Diagnosis basis: 2M readback, class 6 (building) `|n.z|` histogram is flat across 0.0–0.8 (0.02/bin) with no wall peak, ground is clean (97 % > 0.9); user report: full set + 6× radius barely helps, because K = 16 nearest neighbours at 20M density sit within ~0.5 m and the radius slider never widens the PCA support.

## Spec amendment (A11)

| Was | Now |
|---|---|
| normals: k = 16 nearest within radius, register insertion sort | normals: **all** neighbours within radius, single-pass centred covariance (Σd, Σddᵀ, count); `K` removed |
| radius default 3 × spacing, slider 1–6 | default **6 × spacing**, slider 2–10 (no smoothing pass — ruled out after Task 1 measurements, see Task 2) |
| ao: reads `normals` | unchanged |
| shading: `max(|n·v|, 0.15)` headlight; `lit + AO` = × ao | `light = 0.30 + 0.45·|n·v| + 0.25·max(n_world·L, 0)`, `L = normalize(−0.4, −0.3, 0.85)` (world +Z up); `lit + AO` = × `sqrt(ao)`; new debug mode `normals` (colour = `|n_world|`) |
| buffers | unchanged |
| Verify: normals median < 1° | unchanged; AO MAE reported |

Acceptance for this plan: class-6 `|n.z|` wall bin [0, 0.1) at the default radius ≥ 0.10 (2M) / ≥ 0.07 (20M) and coherent per-face colours in the `normals` debug view; `lit + AO` screenshot at the home pose shows solid, directionally shaded boxes with no per-point speckle; 2M build total < 300 ms GPU; 20M builds clean; Verify median < 1°.

## Global Constraints

Same as Phase 4 (pinned deps; kernels return `u32` + `.toVar()`; `i >= count` guards; atomics via `.toAtomic()` + `atomicLoad`; thread-per-word for `ao`; `vertexStage()` for index-derived colour terms; **branchless vertex-stage blends**; vitest in node; console clean; concise commits, no attribution). Branch `phase-4b-normals` from `main`.

---

### Task 0: Branch, diagnostics (`normals` shading mode + class histogram DEV hook), baseline

**Files:**
- Modify: `src/viewer/state/store.ts` (`Shading` gains `'normals'`), `src/viewer/render/pointMaterial.ts`, `src/viewer/ui/Panel.tsx`, `src/viewer/compute/ComputeRunner.tsx`
- Test: `src/viewer/state/store.test.ts` (type only — no runtime change; skip a new test)

**Interfaces:**
- `Shading = 'flat' | 'lit' | 'litAo' | 'normals'`; `SHADING.normals = 3`.
- Material: `debugNormals = step(2.5, shading)`; `colorNode = mix(lutNode.mul(vertexStage(light)), vertexStage(abs(nWorld)), debugNormals)` where `nWorld = normalObj` (positions are centred, model matrix identity → object space is world space).
- DEV hook: `window.__pcvCompute.classStats()` → `Promise<Record<cls, { n, nzHist: number[10], aoMean }>>` computed from `readback()` + `buffers.qpos.array` (class = `word1 >>> 24`).

- [ ] **Step 1: Branch** — `git checkout main && git pull -q && git checkout -b phase-4b-normals`.
- [ ] **Step 2: store** — add `'normals'` to `Shading`. Panel select gains `<option value="normals" disabled={compute.status !== 'built'}>Normals (debug)</option>`.
- [ ] **Step 3: material** — in `pointMaterial.ts` replace the `light` block's tail:

```ts
  const lit = step(0.5, shading)                                 // 1 for lit / litAo / normals
  const useAo = step(1.5, shading)                               // 1 for litAo (and normals, harmless: masked below)
  const debugNormals = step(2.5, shading)                        // 1 for normals
  const light = mix(float(1), lambert.mul(mix(float(1), aoByte, useAo)), lit)
```

and `material.colorNode = mix(lutNode.mul(vertexStage(light)), vertexStage(abs(normalObj)), debugNormals)` (`mix` from `three/tsl`; `abs(normalObj)` is a `vec3`).

- [ ] **Step 4: DEV hook** — in `ComputeRunner.tsx` add to the `__pcvCompute` object:

```ts
        classStats: async () => {
          const { normals, ao } = await p.readback()
          const q = buffers.qpos.array as Uint32Array
          const out: Record<number, { n: number; nzHist: number[]; aoMean: number }> = {}
          for (let i = 0; i < buffers.count; i++) {
            const cls = q[i * 2 + 1] >>> 24
            const nz = Math.abs(octDecode(normals[i])[2])
            const s = (out[cls] ??= { n: 0, nzHist: new Array(10).fill(0), aoMean: 0 })
            s.n++; s.nzHist[Math.min(9, Math.floor(nz * 10))]++; s.aoMean += ((ao[i >> 2] >>> ((i & 3) * 8)) & 0xff) / 255
          }
          for (const s of Object.values(out)) { s.aoMean /= s.n; s.nzHist = s.nzHist.map((v) => v / s.n) }
          return out
        },
```

(import `octDecode` from `./cpu/normals`.)

- [ ] **Step 5: Baseline (browser, demo)** — build, `browser_evaluate` `() => window.__pcvCompute.classStats()`; record class 6 and 2 histograms (expect the Phase 4 smear). Select `Normals (debug)` → screenshot `.playwright-mcp/4b-normals-before.png`; `Lit + AO` → `4b-litao-before.png`. `npx tsc --noEmit && npx vitest run` green. Commit `phase 4b: normals debug shading, class stats hook`.

---

### Task 1: Radius PCA normals (GPU + CPU), drop K/kNN

**Files:**
- Modify: `src/viewer/compute/wgsl/normals.ts`, `src/viewer/compute/cpu/normals.ts`, `src/viewer/compute/cpu/hash.ts` (delete `knn`), `src/viewer/compute/params.ts` (delete `K`)
- Test: `src/viewer/compute/cpu/hash.test.ts` (delete the `knn` describe), `src/viewer/compute/cpu/normals.test.ts` (plane test stays; add a facade test)

**Interfaces:** `normalAt(g, pos, i)` unchanged signature; `normalsKernel` unchanged params.

- [ ] **Step 1: Failing test** — append to `normals.test.ts`:

```ts
  it('noisy vertical facade: normal is horizontal within 10° (radius PCA, no K cap)', () => {
    // wall x = 20 ± 0.15 m depth noise, 3 m × 3 m patch at 1 pt / 0.25 m, plus a roof line at z = 33 leaking in
    const pts: number[] = []
    let s = 21; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    for (let y = 0; y < 12; y++) for (let z = 0; z < 12; z++) pts.push(20 + (r() - 0.5) * 0.3, 10 + y * 0.25, 30 + z * 0.25)
    for (let y = 0; y < 12; y++) pts.push(19.5 + r() * 0.5, 10 + y * 0.25, 33.1)
    const pos = new Float32Array(pts), n = pos.length / 3, g = buildGrid(pos, n, 1.0, 1024)
    const v = normalAt(g, pos, 12 * 6 + 6)           // mid-wall point
    expect(Math.abs(v[2])).toBeLessThan(Math.sin(10 * Math.PI / 180))
  })
```

Run → with the current K = 16 estimator this may pass or fail (16 NN within 0.25–0.5 m of noisy depth); the point of the test is to pin the radius-PCA behaviour — keep it regardless.

- [ ] **Step 2: CPU** — `cpu/normals.ts` `normalAt`:

```ts
export function normalAt(g: Grid, pos: Float32Array, i: number): [number, number, number] {
  // Single-pass covariance of d = p_j − p_i over every neighbour within radius (+ the point itself, d = 0):
  // centring on p_i keeps the sums small so the f32 kernel and this mirror agree.
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  let n = 1, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  forEachNeighbour(g, pos, i, g.radius * g.radius, (j) => {
    const dx = pos[j * 3] - px, dy = pos[j * 3 + 1] - py, dz = pos[j * 3 + 2] - pz
    n++; sx += dx; sy += dy; sz += dz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  })
  if (n < 4) return [0, 0, 1]
  const mx = sx / n, my = sy / n, mz = sz / n
  const v = smallestEigenvector([
    xx / n - mx * mx, xy / n - mx * my, xz / n - mx * mz,
    xy / n - mx * my, yy / n - my * my, yz / n - my * mz,
    xz / n - mx * mz, yz / n - my * mz, zz / n - mz * mz,
  ])
  if (!v) return [0, 0, 1]
  return v[2] < 0 ? [-v[0], -v[1], -v[2]] : v
}
```

(import `forEachNeighbour` instead of `knn`; drop the `K` import.) Delete `knn` from `hash.ts` and its `K` import; delete `K` from `params.ts`; delete the `knn` describe block in `hash.test.ts`.

- [ ] **Step 3: GPU** — `wgsl/normals.ts` body replaces the kNN arrays and the mean/covariance loops with the same single pass (`var n = 1u; var s = vec3<f32>(0.0); var xx = 0.0; …` accumulate `d = pcvDecodePos(qpos[j], dqScale) - p` when `dot(d, d) <= r2`; after the 27-cell loop: `if (n >= 4u) { let m = s / f32(n); cov = (xx/n − m.x·m.x, …) → pcvSmallestEigenvector(...) }`). Update the header comment ("PCA over every neighbour within radius, single-pass centred covariance; mirrors compute/cpu/normals.ts").

- [ ] **Step 4: Gates + browser** — `npx tsc --noEmit && npx vitest run` green (plane test still < 1°; facade test passes). Demo build; `classStats()`; record class 6 histogram; screenshots `4b-normals-pca.png`, `4b-litao-pca.png`. Commit `compute: radius pca normals, drop k-nn`.

---

### Task 2: Default radius 6 × spacing (smoothing pass dropped — ruling after Task 1 measurements)

Measured after Task 1 (radius PCA): class-6 wall bin [0, 0.1) — 20M: 0.021 at 3× (0.67 m) → 0.078 at 6× (1.34 m); 2M: 0.043 at 3× (2.12 m) → 0.109 at 6× (4.24 m). Normals-debug screenshots at 6× show coherent per-face colours at both densities (`.playwright-mcp/4b-normals-20m-x6.png`, `4b-normals-2m-x6.png`). The radius ∝ spacing law holds; the multiplier was too small once the K cap stopped hiding it. Cost at 6×: normals 34 ms @2M, 630 ms @20M; AO 46 / 685 ms. A smoothing pass (+80 MB, +1 pass) is not needed — **A11 amended: no smooth pass; default `radiusMul = 6`, slider 2–10.**

**Files:** `src/viewer/state/store.ts` (`initialState.compute.radiusMul: 6`), `src/viewer/state/store.test.ts` (default → 6), `src/viewer/ui/Panel.tsx` (slider `min={2} max={10}`), `src/viewer/compute/ComputeRunner.tsx` (`cpuCellStart` unchanged).

- [ ] Change the default + test + slider range; `npx tsc --noEmit && npx vitest run` green; browser: demo Build at the default (4.24 m) → `classStats()` class 6 wall bin ≈ 0.11, `Lit + AO` screenshot `.playwright-mcp/4b-litao-x6.png`. Commit `compute: default radius 6× spacing`.

### Task 3: Lighting model

**Files:**
- Modify: `src/viewer/render/pointMaterial.ts`, `docs/ARCHITECTURE.md` (shading math), `README.md` (shading line)

- [ ] **Step 1:** Replace `lambert` with:

```ts
  const SUN = vec3(-0.4, -0.3, 0.85).normalize()                  // world, +Z up; fixed key light from above-left
  const wrap = float(0.30).add(abs(dot(nView, viewDir)).mul(0.45))
  const sun = max(dot(normalObj, SUN), 0).mul(0.25)
  const lambert = wrap.add(sun)                                   // 0.30 … 1.0
  const aoTerm = mix(float(1), aoByte.sqrt(), useAo)              // sqrt: occlusion shades, never masks
  const light = mix(float(1), lambert.mul(aoTerm), lit)
```

(`normalObj` is world-space: model matrix is identity and positions are centred.) Keep `vertexStage(light)`.

- [ ] **Step 2: Browser** — `lit` and `litAo` screenshots at the home pose and one zoomed facade view (`browser_evaluate` can't orbit; use the F key then a scripted wheel event on the canvas: `canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))` ×3, wait 1 s); compare with `4b-*-before.png`. HUD ms unchanged (vertex-stage math). Commit `material: wrap + sun lighting, sqrt ao`.

---

### Task 4: Docs, spec, merge

- [ ] README: shading description + new timing row (2M / 20M `smooth`), memory line (+80 MB). ARCHITECTURE: Compute section — normals estimator (radius PCA, why K was wrong at 20M), smoothing pass, lighting formula, class histogram before/after numbers, `normals` debug mode, memory table. Master spec: add **A11** (this amendment); phase-4 spec: "Amended by A11 (2026-09-18)" note under Passes 4 and UI. Deferred: `normalsTmp` could be freed after the build (same no-API limitation).
- [ ] Gates (`tsc`, `vitest`, `build`, `pytest`), whole-branch review, `git merge --no-ff phase-4b-normals`, push, delete branch, `/deslop` over the changed surface.

## Unresolved questions
- Smoothing radius = same slider radius (simplest) — ok, or a separate multiplier?
- Keep `normals` debug shading in the public panel, or DEV-only?
