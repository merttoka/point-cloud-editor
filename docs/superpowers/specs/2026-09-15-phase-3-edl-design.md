# Phase 3: Eye-Dome Lighting — Design Spec

Date: 2026-09-15
Status: approved (brainstorm)
Parent: `2026-09-15-point-cloud-editor-design.md` §2 "Eye-dome lighting", §7.3

## Goal

Add a screen-space eye-dome lighting (EDL, Boucheny 2009) post pass so unlit point clouds read as surfaces, with radius/strength controls and a toggle, at ≤ +2 ms per frame at 20M points, DPR 1.

## Scope

In: post pipeline over the Phase 2 scene, EDL kernel, two panel sliders + toggle, HUD unchanged, ARCHITECTURE section.
Out: SSAO or any other screen-space effect, MSAA, resolution scaling, EDL on the CPU benchmark path, shading with normals (Phase 4).

## Interfaces

### Layout
```
src/viewer/render/postprocessing.ts   # builds the pipeline; owns the pass node + EDL params
src/viewer/render/edl.ts              # edlShade(): pure TSL Fn (colour, logDepth taps) → shaded colour; plus edlObscurance() TS mirror
src/viewer/render/Scene.tsx           # useFrame(priority 1) → pipeline.render()
src/viewer/ui/Panel.tsx               # "Lighting" group: EDL on/off, radius, strength
```

### Pipeline (three 0.186)
- `new THREE.RenderPipeline(renderer, outputNode)` (`three/webgpu`). `PostProcessing` is the same class under a name deprecated since r183; do not use it.
- `const scenePass = pass(scene, camera)` (`three/tsl`). Colour: `scenePass.getTextureNode('output')`. Depth: `scenePass.getViewZNode('depth')` (view-space Z, negative in front of the camera); `getLinearDepthNode('depth')` also exists but is orthographic-mapped, not used. `getTextureNode('depth')` gives the raw depth texture node if a tap needs `.sample(uv)` at an offset.
- `pipeline.outputNode = edlShade(...)`; `pipeline.outputColorTransform` stays `true` (default) so tone mapping/colour space are applied once, after EDL.
- Sample offsets use `screenSize` (`three/tsl`) so the radius is in physical pixels: `uvOffset = dir * radiusPx * dpr / screenSize`. `radiusPx` is a CSS-px uniform; `dpr` comes from `renderer.getPixelRatio()`.
- Pass render target: `HalfFloatType` colour, `DepthTexture` (`FloatType` on WebGPU per `PassNode.setup`), `samples: 0` (no MSAA; matches the antialias-off renderer).
- Toggle off = `pipeline.outputNode = scenePass` (colour passthrough), not a bypass of the pipeline, so the frame path is identical either way and "off" output equals the Phase 2 render bit-for-bit.

### r3f handover (fiber 9.7.0)
`useFrame(() => pipeline.render(), 1)`. Any subscriber with `priority > 0` increments `internal.priority`, and the loop only calls `gl.render(scene, camera)` when `internal.priority === 0` (`events-*.esm.js`, `subscribe` and `loop`), so the pipeline becomes the sole renderer. `frameloop` stays `"always"`. On unmount the subscription's cleanup decrements the flag and r3f resumes its own render.

### EDL kernel (`edl.ts`)
Per fragment at uv:
```
d0 = log2(max(-viewZ(uv), near))                      // log depth of centre
for k in 0..7:  dir_k = (cos(kπ/4), sin(kπ/4))
  d_k = log2(max(-viewZ(uv + dir_k * off), near))
  obs += max(0, d0 - d_k)                              // neighbours closer than centre occlude
obs /= 8
shade = exp(-strength * obs * 300 / radiusPx)          // Boucheny's scaling; 300 keeps strength ≈ 1 sensible
colour = sceneColour * shade
```
Background: if `-viewZ(uv) >= far * 0.999` → shade = 1 (no darkening of empty sky at silhouette edges). Neighbour taps at the far plane contribute 0 (treated as `d_k = d0`) so silhouettes keep their own shade rather than a halo.
Params (uniforms): `radiusPx` 1–4, default 1.5; `strength` 0–4, default 1; `enabled` (panel; swaps `outputNode`). `near`/`far` read from the camera each frame.

### Panel
"Lighting" group in the existing control panel: checkbox EDL (default on), slider radius (px), slider strength. Values live in the viewer store; `Scene.tsx` writes the uniforms on change.

## Acceptance criteria

- Screenshots on the demo set before/after EDL show visible surface relief (roofs vs walls, tree crowns).
- HUD frame ms at 20M, DPR 1, size 3 px: EDL on − EDL off ≤ 2.0 ms (report both).
- No visible seams at chunk borders (the pass is screen-space; check a screenshot across a chunk boundary).
- Toggle off → pixel-identical to the Phase 2 render (Playwright screenshot diff = 0).
- DPR 2: radius visually equal in CSS px to DPR 1 (offset scales with `dpr`).
- Console clean (only the two benign warnings noted in ARCHITECTURE).

## Risks and spikes

- **Depth read on WebGPU**: `getViewZNode('depth')` samples the pass depth texture; confirm it resolves in a fragment post pass over Sprite quads (spike: constant-colour output from `viewZ` before the kernel). Fallback: `getTextureNode('depth').sample(uv)` + manual `perspectiveDepthToViewZ` from `three/tsl`.
- **r3f + RenderPipeline resize**: `pass()` sizes its target from the renderer in `setup`; verify canvas resize keeps colour/depth in sync (spike: resize the window, screenshot). Fallback: call `scenePass.setSize(w, h)` from r3f's `size` state.
- **Tone mapping double-apply**: if the Phase 2 render already writes sRGB, keep `outputColorTransform = true` and ensure the pass target stays linear `HalfFloatType`.
- **Cost**: 9 depth samples + 1 colour per pixel; at 4K DPR 2 this may exceed 2 ms. Acceptance is DPR 1; document DPR 2 numbers.

## Tests

- vitest: `edlObscurance(d0, taps[])` and `edlShade(obs, strength, radius)` as pure TS mirrors of the TSL formula: zero obscurance on a flat plane, positive on a step edge, symmetry across the 8 taps, background rule, monotonic in strength.
- Playwright smoke (in-plan, MCP tools): load demo, toggle EDL on/off, screenshots, HUD ms both states, console clean, resize.

## Docs

ARCHITECTURE: "Post-processing" section (RenderPipeline, r3f priority handover, EDL formula, params, measured cost). README: controls table gains EDL row; perf table gains the EDL delta.
