# Phase 0: Scaffold + WebGPU Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pinned Vite/React/R3F/WebGPU project and prove the four risky assumptions (sized points, u16-packed positions, raw-WGSL compute → Three render buffer, GPU timestamps) on a 2M–20M synthetic cloud before any real feature work.

**Architecture:** R3F `<Canvas>` hosting a `WebGPURenderer`. Point positions live in one `StorageInstancedBufferAttribute` (`Uint32Array`, 2 words per point) that compute reads/writes as storage and the render material reads as an instanced vertex attribute. A packed-u8 `flags` storage buffer is written by a compute pass and read in the vertex shader. Everything spike-specific lives in `src/spike/`; reusable format helpers live in `src/viewer/format/`.

**Tech Stack:** three 0.186.0 (`three/webgpu`, `three/tsl`), @react-three/fiber 9.7.0, @react-three/drei 10.7.8, react 19.3.0, vite 8.3.0, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md`

## Global Constraints

- Pinned exact: `three@0.186.0`, `@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`, `react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.0`.
- WebGPU required. No WebGL fallback. Unsupported browser → message.
- Compute kernels: raw WGSL via TSL `wgslFn` + `storage()` nodes. No `renderer.backend` internals.
- No leva. Debug UI hand-rolled.
- `src/viewer/` self-contained, CSS modules only, no global CSS.
- Point byte format v1: `[u16 x][u16 y][u16 z][u16 packed = intensity | (class << 8)]`, little-endian, 8 B/pt.
- Repo public, MIT. Branch per phase, merge to main. Commit messages: concise, no attribution lines.
- Raw LAZ never committed (irrelevant this phase; `.gitignore` set up now).
- Any spike failure revises the spec before phase 1 (Task 6).
- Browser checks (Tasks 3–5): drive Chrome with the playwright MCP tools (`browser_navigate`, `browser_console_messages`, `browser_take_screenshot`, `browser_evaluate`). Read `#hud` / `#compute` text via `browser_evaluate`. No human in the loop.
- Task 6 creates the public GitHub repo via `gh repo create`. Do it.

---

### Task 1: Project scaffold + format helpers

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`, `LICENSE`, `README.md`
- Create: `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`
- Create: `src/viewer/format/quant.ts`
- Test: `src/viewer/format/quant.test.ts`

**Interfaces:**
- Produces: `Bounds`, `QMAX`, `quantize(v, min, max): number`, `dequantize(q, min, max): number`, `dequantScale(b: Bounds): [number, number, number]`, `packAttr(intensity, cls): number`, `unpackAttr(packed): { intensity, cls }`, `packWords(x, y, z, packed): [number, number]`, `unpackWords(w0, w1): [x, y, z, packed]`.

- [ ] **Step 1: Create branch**

```bash
cd ~/Developer/Graphics/TS_PointCloud
git checkout -b phase-0-scaffold
```

- [ ] **Step 2: Write package.json and install pinned deps**

```json
{
  "name": "point-cloud-editor",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

```bash
npm i three@0.186.0 @react-three/fiber@9.7.0 @react-three/drei@10.7.8 react@19.3.0 react-dom@19.3.0
npm i -D vite@8.3.0 @vitejs/plugin-react typescript vitest @types/react @types/react-dom @types/three @webgpu/types
```

If `@types/three` for 0.186 is not published yet, `npm i -D @types/three@latest` and note the version in README.

- [ ] **Step 3: Write config files**

`vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": ["@webgpu/types", "vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Point Cloud Editor</title>
    <style>html,body,#root{margin:0;height:100%;background:#111;color:#eee;font:12px/1.4 ui-monospace,monospace}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
(Inline style here is app-shell only; `src/viewer/` stays CSS-modules-only.)

`.gitignore`:
```
node_modules
dist
data/raw
.DS_Store
*.local
```

`LICENSE`: MIT text, `Copyright (c) 2026 Mert Toka`.

`README.md`:
```markdown
# Point Cloud Editor

Clean-room WebGPU point cloud viewer/editor. 5–20M point LiDAR, WGSL compute, editing, explicit perf numbers.

## Status
Phase 0: scaffold + spike.

## Setup
npm install
npm run dev        # Chrome with WebGPU
npm test
npm run build

## Spike params
`?n=2000000&size=3` — point count, point size px.
```

`src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/App.tsx` (placeholder until Task 3 replaces it):
```tsx
export function App() {
  return <div style={{ padding: 16 }}>point-cloud-editor</div>
}
```

- [ ] **Step 4: Verify build + dev boot**

Run: `npm run build`
Expected: `dist/` produced, no TS errors.

- [ ] **Step 5: Write failing tests for format helpers**

`src/viewer/format/quant.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  QMAX, quantize, dequantize, dequantScale, packAttr, unpackAttr, packWords, unpackWords,
  type Bounds,
} from './quant'

describe('quantize/dequantize', () => {
  it('round-trips within half a quantization step', () => {
    const min = -100, max = 900
    const step = (max - min) / QMAX
    for (const v of [-100, 0, 123.456, 899.99, 900]) {
      const q = quantize(v, min, max)
      expect(q).toBeGreaterThanOrEqual(0)
      expect(q).toBeLessThanOrEqual(QMAX)
      expect(Math.abs(dequantize(q, min, max) - v)).toBeLessThanOrEqual(step / 2 + 1e-9)
    }
  })
  it('degenerate range quantizes to 0', () => {
    expect(quantize(5, 5, 5)).toBe(0)
    expect(dequantize(0, 5, 5)).toBe(5)
  })
  it('dequantScale is (max-min)/QMAX per axis', () => {
    const b: Bounds = { min: [0, 10, 20], max: [65535, 65545, 20] }
    expect(dequantScale(b)).toEqual([1, 10 / QMAX, 0])
  })
})

describe('packAttr/unpackAttr', () => {
  it('packs intensity low byte, class high byte', () => {
    const p = packAttr(7, 6)
    expect(p).toBe(7 | (6 << 8))
    expect(unpackAttr(p)).toEqual({ intensity: 7, cls: 6 })
  })
  it('matches on-disk little-endian byte order [intensity][class]', () => {
    const bytes = new Uint8Array(new Uint16Array([packAttr(0xab, 0xcd)]).buffer)
    expect(Array.from(bytes)).toEqual([0xab, 0xcd])
  })
})

describe('packWords/unpackWords', () => {
  it('two u32 words carry x|y<<16 and z|packed<<16', () => {
    const [w0, w1] = packWords(1, 2, 3, packAttr(4, 5))
    expect(w0 >>> 0).toBe(1 | (2 << 16))
    expect(w1 >>> 0).toBe(3 | (packAttr(4, 5) << 16))
    expect(unpackWords(w0, w1)).toEqual([1, 2, 3, packAttr(4, 5)])
  })
  it('u32 view of on-disk bytes equals packWords', () => {
    const disk = new Uint16Array([100, 200, 300, packAttr(9, 2)])
    const words = new Uint32Array(disk.buffer)
    const [w0, w1] = packWords(100, 200, 300, packAttr(9, 2))
    expect(words[0]).toBe(w0 >>> 0)
    expect(words[1]).toBe(w1 >>> 0)
  })
  it('handles max u16 values without sign issues', () => {
    const [w0, w1] = packWords(65535, 65535, 65535, 65535)
    expect(unpackWords(w0, w1)).toEqual([65535, 65535, 65535, 65535])
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module './quant'`.

- [ ] **Step 7: Implement quant.ts**

`src/viewer/format/quant.ts`:
```ts
export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export const QMAX = 65535

export function quantize(v: number, min: number, max: number): number {
  if (max === min) return 0
  const q = Math.round(((v - min) / (max - min)) * QMAX)
  return Math.min(QMAX, Math.max(0, q))
}

export function dequantize(q: number, min: number, max: number): number {
  return min + (q / QMAX) * (max - min)
}

export function dequantScale(b: Bounds): [number, number, number] {
  return [
    (b.max[0] - b.min[0]) / QMAX,
    (b.max[1] - b.min[1]) / QMAX,
    (b.max[2] - b.min[2]) / QMAX,
  ]
}

export function packAttr(intensity: number, cls: number): number {
  return (intensity & 0xff) | ((cls & 0xff) << 8)
}

export function unpackAttr(packed: number): { intensity: number; cls: number } {
  return { intensity: packed & 0xff, cls: (packed >>> 8) & 0xff }
}

/** Two little-endian u32 words per point: [x | y<<16, z | packed<<16]. Same bytes as v1 disk format. */
export function packWords(x: number, y: number, z: number, packed: number): [number, number] {
  return [((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0, ((z & 0xffff) | ((packed & 0xffff) << 16)) >>> 0]
}

export function unpackWords(w0: number, w1: number): [number, number, number, number] {
  return [w0 & 0xffff, (w0 >>> 16) & 0xffff, w1 & 0xffff, (w1 >>> 16) & 0xffff]
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 8 tests.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "scaffold vite/r3f/webgpu project, add point format helpers"
```

---

### Task 2: Synthetic point cloud generator

**Files:**
- Create: `src/spike/synthetic.ts`
- Test: `src/spike/synthetic.test.ts`

**Interfaces:**
- Consumes: `quantize`, `packAttr`, `packWords`, `Bounds` from `src/viewer/format/quant.ts`.
- Produces: `mulberry32(seed): () => number`, `makeSyntheticCloud(count, seed?): SyntheticCloud` where `SyntheticCloud = { words: Uint32Array /* count*2 */, bounds: Bounds, count: number }`.

- [ ] **Step 1: Write failing tests**

`src/spike/synthetic.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeSyntheticCloud, mulberry32 } from './synthetic'
import { unpackWords, unpackAttr } from '../viewer/format/quant'

describe('mulberry32', () => {
  it('is deterministic and in [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('makeSyntheticCloud', () => {
  it('emits count*2 words with bounds 1000x1000x300', () => {
    const c = makeSyntheticCloud(1000)
    expect(c.count).toBe(1000)
    expect(c.words.length).toBe(2000)
    expect(c.bounds).toEqual({ min: [0, 0, 0], max: [1000, 1000, 300] })
  })
  it('all fields unpack to valid ranges and classes {2,5,6}', () => {
    const c = makeSyntheticCloud(5000, 7)
    const classes = new Set<number>()
    for (let i = 0; i < c.count; i++) {
      const [x, y, z, packed] = unpackWords(c.words[i * 2], c.words[i * 2 + 1])
      expect(x).toBeLessThanOrEqual(65535)
      expect(y).toBeLessThanOrEqual(65535)
      expect(z).toBeLessThanOrEqual(65535)
      const { intensity, cls } = unpackAttr(packed)
      expect(intensity).toBeLessThanOrEqual(255)
      classes.add(cls)
    }
    expect(classes).toEqual(new Set([2, 5, 6]))
  })
  it('is deterministic for a seed', () => {
    const a = makeSyntheticCloud(100, 3), b = makeSyntheticCloud(100, 3)
    expect(a.words).toEqual(b.words)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- synthetic`
Expected: FAIL, `Cannot find module './synthetic'`.

- [ ] **Step 3: Implement synthetic.ts**

Ground = rolling terrain (class 2). ~10% of points are "buildings" (class 6): boxes on a 50 m grid, points on roof + walls. ~15% are "trees" (class 5): random vertical columns with noise.

`src/spike/synthetic.ts`:
```ts
import { quantize, packAttr, packWords, type Bounds } from '../viewer/format/quant'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SyntheticCloud {
  words: Uint32Array
  bounds: Bounds
  count: number
}

const BOUNDS: Bounds = { min: [0, 0, 0], max: [1000, 1000, 300] }

function ground(x: number, y: number): number {
  return 40 + 15 * Math.sin(x / 90) * Math.cos(y / 70) + 5 * Math.sin((x + y) / 23)
}

export function makeSyntheticCloud(count: number, seed = 1): SyntheticCloud {
  const rand = mulberry32(seed)
  const words = new Uint32Array(count * 2)
  const [mx, my, mz] = BOUNDS.min
  const [Mx, My, Mz] = BOUNDS.max

  for (let i = 0; i < count; i++) {
    const r = rand()
    let x = rand() * 1000
    let y = rand() * 1000
    let z: number
    let cls: number
    if (r < 0.1) {
      // building: snap XY to a 50 m grid cell footprint (30x30), roof or wall
      const cx = Math.floor(x / 50) * 50 + 10
      const cy = Math.floor(y / 50) * 50 + 10
      const h = 15 + ((Math.floor(x / 50) * 7 + Math.floor(y / 50) * 13) % 25)
      const base = ground(cx + 15, cy + 15)
      if (rand() < 0.6) {
        x = cx + rand() * 30; y = cy + rand() * 30; z = base + h
      } else {
        const side = rand()
        if (side < 0.5) { x = cx + (side < 0.25 ? 0 : 30); y = cy + rand() * 30 }
        else { x = cx + rand() * 30; y = cy + (side < 0.75 ? 0 : 30) }
        z = base + rand() * h
      }
      cls = 6
    } else if (r < 0.25) {
      // tree: column of noise above ground
      const tx = x, ty = y
      x = tx + (rand() - 0.5) * 6
      y = ty + (rand() - 0.5) * 6
      z = ground(tx, ty) + 3 + rand() * 12
      cls = 5
    } else {
      z = ground(x, y) + (rand() - 0.5) * 0.3
      cls = 2
    }
    const intensity = Math.floor(rand() * 256)
    const [w0, w1] = packWords(
      quantize(x, mx, Mx), quantize(y, my, My), quantize(z, mz, Mz), packAttr(intensity, cls),
    )
    words[i * 2] = w0
    words[i * 2 + 1] = w1
  }
  return { words, bounds: BOUNDS, count }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/spike
git commit -m "add deterministic synthetic lidar-like cloud generator"
```

---

### Task 3: Render spike — sized points from packed u16 positions

Proves spec blockers #2 (point size in WebGPU) and #3 (u16 vertex format) and #4 (manual bounds).

**Files:**
- Create: `src/spike/SpikeApp.tsx`, `src/spike/SpikePoints.tsx`, `src/spike/Hud.tsx`, `src/spike/params.ts`
- Modify: `src/App.tsx`
- Create: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `makeSyntheticCloud` (Task 2), `dequantScale` (Task 1).
- Produces: `spikeParams(): { n: number; size: number }`; `SpikePoints` builds `THREE.Points` with instanced `qpos` attribute; exposes `cloudRef` pattern used by Task 4.

- [ ] **Step 1: Params helper**

`src/spike/params.ts`:
```ts
export function spikeParams(): { n: number; size: number } {
  const q = new URLSearchParams(window.location.search)
  const n = Math.max(1, Math.min(30_000_000, Number(q.get('n') ?? 2_000_000)))
  const size = Math.max(1, Math.min(32, Number(q.get('size') ?? 3)))
  return { n, size }
}
```

- [ ] **Step 2: HUD component (writes to a DOM node outside the Canvas)**

`src/spike/Hud.tsx`:
```tsx
import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'

export function Hud() {
  const { gl } = useThree()
  const ema = useRef(16)
  const last = useRef(performance.now())
  useFrame(() => {
    const now = performance.now()
    const dt = now - last.current
    last.current = now
    ema.current = ema.current * 0.9 + dt * 0.1
    const el = document.getElementById('hud')
    if (!el) return
    const info = (gl as unknown as WebGPURenderer).info
    el.textContent =
      `${ema.current.toFixed(2)} ms  ${(1000 / ema.current).toFixed(0)} fps` +
      `  draws ${info.render.drawCalls}  pts ${info.render.points}  tris ${info.render.triangles}`
  })
  return null
}
```
`info.render.triangles > 0` on a Points draw tells us Three expanded points to quads.

- [ ] **Step 3: Points component**

`src/spike/SpikePoints.tsx`:
```tsx
import { useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { attribute, color, float, instanceIndex, select, storage, uniform, uint, vec3 } from 'three/tsl'
import { makeSyntheticCloud } from './synthetic'
import { dequantScale } from '../viewer/format/quant'

export function SpikePoints({ count, size }: { count: number; size: number }) {
  const points = useMemo(() => {
    const cloud = makeSyntheticCloud(count)
    const b = cloud.bounds

    // Positions: 2 u32 words per point, instanced. Same buffer is readable by compute (Task 4).
    const qposAttr = new THREE.StorageInstancedBufferAttribute(cloud.words, 2)
    const qpos = storage(qposAttr, 'uvec2', count)

    // Draw 1 vertex per instance; instanceIndex == point index.
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
    geometry.setAttribute('qpos', qposAttr)
    geometry.drawRange.count = 1

    // Three cannot derive bounds from qpos; set manually so frustum culling works.
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))
    geometry.boundingBox = box
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere())

    const dqMin = uniform(new THREE.Vector3(...b.min))
    const dqScale = uniform(new THREE.Vector3(...dequantScale(b)))

    const w = qpos.toAttribute()                       // uvec2 per instance
    const x = w.x.bitAnd(uint(0xffff))
    const y = w.x.shiftRight(uint(16))
    const z = w.y.bitAnd(uint(0xffff))
    const cls = w.y.shiftRight(uint(24)).bitAnd(uint(0xff))

    const material = new THREE.PointsNodeMaterial()
    material.positionNode = vec3(x, y, z).mul(dqScale).add(dqMin)
    material.sizeNode = float(size)
    material.sizeAttenuation = false
    material.colorNode = select(
      cls.equal(uint(6)), color('#e0a040'),
      select(cls.equal(uint(5)), color('#4caf50'), color('#9a9a9a')),
    )

    const pts = new THREE.Points(geometry, material)
    pts.count = count
    pts.frustumCulled = true
    // Expose for Task 4
    ;(pts as any).__spike = { qpos, qposAttr, count, material, cls, instanceIndex }
    return pts
  }, [count, size])

  return <primitive object={points} />
}
```

- [ ] **Step 4: Canvas + app shell**

`src/spike/SpikeApp.tsx`:
```tsx
import { Canvas, extend } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { OrbitControls } from '@react-three/drei'
import { SpikePoints } from './SpikePoints'
import { Hud } from './Hud'
import { spikeParams } from './params'

extend(THREE as any)

export function SpikeApp() {
  const { n, size } = spikeParams()
  if (!('gpu' in navigator)) {
    return <div style={{ padding: 16 }}>WebGPU not available in this browser.</div>
  }
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div id="hud" style={{ position: 'absolute', top: 8, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <div id="compute" style={{ position: 'absolute', top: 28, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <Canvas
        camera={{ position: [1500, 1200, 1500], near: 1, far: 20000, fov: 50, up: [0, 0, 1] }}
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer({
            ...(props as Record<string, unknown>),
            antialias: false,
            trackTimestamp: true,
          })
          await renderer.init()
          return renderer
        }}
      >
        <SpikePoints count={n} size={size} />
        <OrbitControls target={[500, 500, 40]} makeDefault enableDamping />
        <Hud />
      </Canvas>
    </div>
  )
}
```

`src/App.tsx`:
```tsx
import { SpikeApp } from './spike/SpikeApp'

export function App() {
  return <SpikeApp />
}
```

- [ ] **Step 5: Run and observe in Chrome**

Run: `npm run dev`, open `http://localhost:5173/?n=2000000&size=3` in Chrome.

Check, and write each result into `docs/ARCHITECTURE.md` under `## Phase 0 spike findings` (create the file now with that heading):
1. Console: zero errors. If a pipeline/shader error mentions `qpos`, `uvec2`, or `vertex buffer`, record the exact text.
2. Terrain + orange boxes + green columns visible; orbit works.
3. Reload with `?size=8`: dots visibly larger than at `size=3`. If NOT (always 1px), sized points are unsupported for `Points` → go to Step 6 fallback.
4. HUD line: record `pts` vs `tris` values (tris > 0 ⇒ Three expands to quads; ratio tells verts/point).
5. Orbit so the whole cloud leaves the frustum: `draws` must go to 0 (proves manual bounds + culling).

- [ ] **Step 6: Fallback only if Step 5.3 failed — billboard quads via SpriteNodeMaterial**

Replace the material/object construction in `SpikePoints.tsx` with:

```tsx
    const quad = new THREE.PlaneGeometry(1, 1)
    quad.setAttribute('qpos', qposAttr)
    quad.boundingBox = box
    quad.boundingSphere = box.getBoundingSphere(new THREE.Sphere())

    const material = new THREE.SpriteNodeMaterial()
    material.positionNode = vec3(x, y, z).mul(dqScale).add(dqMin)
    material.scaleNode = float(size)          // px when sizeAttenuation=false
    material.sizeAttenuation = false
    material.colorNode = /* same select() as above */

    const pts = new THREE.Sprite(material)
    pts.geometry = quad
    pts.count = count
    pts.frustumCulled = false                   // Sprite culling ignores custom bounds; chunk culling done manually in phase 2
```
Re-run Step 5 checks 1–4 and record which path (A: Points, B: Sprite quads) is used. Only one path stays in the file.

- [ ] **Step 7: Record findings + commit**

`docs/ARCHITECTURE.md` (append to what Step 5 created):
```markdown
# Architecture

## Phase 0 spike findings (three 0.186.0)

- Point draw mechanism: <Points+PointsNodeMaterial | Sprite quads>; verts/point = <n>; HUD tris/pts = <values>.
- Positions: `StorageInstancedBufferAttribute(Uint32Array, 2)` → `uint32x2` instanced attribute; bit-unpack in vertex.
  `uint16x3` is not a WebGPU vertex format; `uint16x4` would block compute reads (no u16 in WGSL). Words layout = disk bytes.
- Point index in vertex stage: `instanceIndex`.
- Bounds: set `geometry.boundingBox/boundingSphere` manually; culling verified (draws→0 off-screen).
- 2M @ size 3: <ms> ms / <fps> fps on <machine>.
```

```bash
git add -A
git commit -m "render spike: 2M sized points from packed u16 positions"
```

---

### Task 4: Compute spike — wgslFn writes flags, vertex shader reads them, GPU timing

Proves spec blocker #1 (raw WGSL ↔ Three buffers) and timestamps.

**Files:**
- Create: `src/spike/flagsCompute.ts`
- Modify: `src/spike/SpikePoints.tsx`

**Interfaces:**
- Consumes: `qpos` storage node, `qposAttr`, `count` from Task 3.
- Produces: `buildFlagsCompute(qpos, count): { flagsAttr: StorageBufferAttribute; flags: StorageBufferNode; computeNode: ComputeNode; words: number }`.

- [ ] **Step 1: Compute module — primary path (raw WGSL, pointer params)**

Kernel: one thread per u32 word (4 points). Sets flag bit0 for points whose quantized x > 32767 (east half). Thread-per-word avoids atomics for packed-u8 writes; record this rule in ARCHITECTURE (lasso/select passes must also write per-word or use `atomicOr`).

`src/spike/flagsCompute.ts`:
```ts
import * as THREE from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, wgslFn } from 'three/tsl'
import type { StorageBufferNode } from 'three/webgpu'

const classifyEast = wgslFn(/* wgsl */ `
  fn classifyEast(
    qpos: ptr<storage, array<vec2<u32>>, read_write>,
    flags: ptr<storage, array<u32>, read_write>,
    word: u32,
    count: u32
  ) -> void {
    var out: u32 = 0u;
    for (var k: u32 = 0u; k < 4u; k = k + 1u) {
      let i = word * 4u + k;
      if (i >= count) { break; }
      let x = qpos[i].x & 0xffffu;
      if (x > 32767u) { out = out | (1u << (k * 8u)); }
    }
    flags[word] = out;
  }
`)

export function buildFlagsCompute(qpos: StorageBufferNode, count: number) {
  const words = Math.ceil(count / 4)
  const flagsAttr = new THREE.StorageBufferAttribute(new Uint32Array(words), 1)
  const flags = storage(flagsAttr, 'uint', words)
  const computeNode = Fn(() => {
    classifyEast({ qpos, flags, word: instanceIndex, count: uint(count) })
  })().compute(words)
  return { flagsAttr, flags, computeNode, words }
}
```

- [ ] **Step 2: Fallback body only if `wgslFn` rejects pointer params (record the error text in ARCHITECTURE)**

Replace `computeNode` with pure TSL:
```ts
import { If, Loop } from 'three/tsl'
// ...
  const computeNode = Fn(() => {
    const word = instanceIndex
    const out = uint(0).toVar()
    Loop({ start: uint(0), end: uint(4), type: 'uint' }, ({ i: k }) => {
      const i = word.mul(uint(4)).add(k)
      If(i.lessThan(uint(count)), () => {
        const x = qpos.element(i).x.bitAnd(uint(0xffff))
        If(x.greaterThan(uint(32767)), () => {
          out.assign(out.bitOr(uint(1).shiftLeft(k.mul(uint(8)))))
        })
      })
    })
    flags.element(word).assign(out)
  })().compute(words)
```
If this fallback is needed, the spec's "raw WGSL via wgslFn" becomes "TSL kernels, `wgslFn` for pure-math helpers only" (Task 6).

- [ ] **Step 3: Wire into SpikePoints — read flags in vertex, dispatch once, time it**

Modify `src/spike/SpikePoints.tsx`:

Add imports:
```tsx
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { buildFlagsCompute } from './flagsCompute'
```

Inside `useMemo`, after `const qpos = storage(...)` add:
```tsx
    const fc = buildFlagsCompute(qpos, count)
    const flagsRO = fc.flags.toReadOnly()          // vertex stage: read-only storage
    const idx = instanceIndex
    const fword = flagsRO.element(idx.shiftRight(uint(2)))
    const fbyte = fword.shiftRight(idx.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))
    const isEast = fbyte.bitAnd(uint(1)).notEqual(uint(0))
```
Change `material.colorNode` to:
```tsx
    const base = select(
      cls.equal(uint(6)), color('#e0a040'),
      select(cls.equal(uint(5)), color('#4caf50'), color('#9a9a9a')),
    )
    material.colorNode = select(isEast, color('#ff3b30'), base)
```
Store on the object: `;(pts as any).__spike = { fc }` (replace the earlier `__spike` line).

After `useMemo`, add:
```tsx
  const { gl } = useThree()
  useEffect(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer
    const { fc } = (points as any).__spike as { fc: ReturnType<typeof buildFlagsCompute> }
    let cancelled = false
    ;(async () => {
      const hasTs = renderer.hasFeature('timestamp-query')
      const t0 = performance.now()
      await renderer.computeAsync(fc.computeNode)
      const cpuMs = performance.now() - t0
      let gpuMs: number | undefined
      if (hasTs) {
        gpuMs = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)
        if (gpuMs === undefined) gpuMs = renderer.info.compute.timestamp
      }
      if (cancelled) return
      const el = document.getElementById('compute')
      if (el) el.textContent = `flags compute: ${fc.words} words, wall ${cpuMs.toFixed(2)} ms, gpu ${gpuMs?.toFixed(3) ?? 'n/a (no timestamp-query)'} ms`
    })()
    return () => { cancelled = true }
  }, [gl, points])
```

- [ ] **Step 4: Run and observe**

Run: `npm run dev`, open `http://localhost:5173/?n=2000000&size=3`.

Check and record in `docs/ARCHITECTURE.md`:
1. Console: zero errors. If `wgslFn` pointer args fail, apply Step 2 and record the error text.
2. East half of the cloud (x > 500) is red, west half keeps class colours. If the split is wrong or all one colour, the index path (`instanceIndex` vs point) is wrong; record what you see, try `vertexIndex` in place of `instanceIndex` for `idx`, record which works.
3. `#compute` line shows wall ms and gpu ms. Record both. If gpu is `n/a`, record that `timestamp-query` is unavailable on this adapter.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "compute spike: wgsl flags pass read by vertex shader, gpu timing"
```

---

### Task 5: Scale check 2M / 10M / 20M

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Measure**

For each of `?n=2000000`, `?n=10000000`, `?n=20000000` (size=3, default camera, then orbit a few seconds, let the HUD settle):
- record HUD frame ms + fps, `pts`/`tris`;
- record compute wall + gpu ms;
- record Chrome task manager GPU memory for the tab (`Shift+Esc`, enable "GPU memory" column);
- record generation wall time (add a `console.time('synthetic')`/`console.timeEnd('synthetic')` around `makeSyntheticCloud` in `SpikePoints.tsx`).

If 20M fails to allocate or Chrome kills the tab, record the failure and the largest N that works.

- [ ] **Step 2: Write table**

Append to `docs/ARCHITECTURE.md`:
```markdown
### Scale (synthetic, M1, Chrome <version>)

| N | frame ms | fps | verts/frame | flags compute gpu ms | GPU mem MB |
|---|---|---|---|---|---|
| 2M | | | | | |
| 10M | | | | | |
| 20M | | | | | |
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md src/spike/SpikePoints.tsx
git commit -m "spike scale numbers 2M/10M/20M"
```

---

### Task 6: Spec revision + README + merge

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-point-cloud-editor-design.md`
- Modify: `README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Amend spec from findings**

Apply every finding to the spec, minimum:
1. §1 "Point format" + §2 `render/`: replace the `uint16x4` sentence with: "Loaded as `Uint32Array` (2 words/pt, `x | y<<16`, `z | packed<<16`) into a `StorageInstancedBufferAttribute`; render reads it as a `uint32x2` instanced attribute and bit-unpacks; compute reads the same buffer as `array<vec2<u32>>`. `Points` draws 1 vertex × N instances; point index = `instanceIndex`."
2. §2 `render/`: replace the "Three renders sized Points as instanced quads → verified in phase 0" sentence with the measured mechanism and verts/point.
3. §2 flags: add "Packed-u8 writes from compute are thread-per-word or `atomicOr`; never plain per-byte stores."
4. §3: if the TSL fallback (Task 4 Step 2) was needed, change "raw WGSL via `wgslFn`" to "TSL kernels; `wgslFn` for pure-math helpers (Jacobi, oct-encode)".
5. §3 timing: if `timestamp-query` was unavailable, note wall-clock fallback for the table.
6. §2 Memory budget: replace estimates with measured GPU MB at 20M.
7. §5 README perf table: pre-fill the spike row as a baseline.
8. If sprite fallback (Task 3 Step 6) was used: §2 `render/` → "one `Sprite` per chunk, `frustumCulled=false`, chunk visibility toggled manually from manifest AABB vs frustum".

- [ ] **Step 2: README**

Update `## Status` to "Phase 0 done: spike results in docs/ARCHITECTURE.md" and add a `## Spike results` section copying the scale table.

- [ ] **Step 3: Final checks**

Run: `npm test` → PASS. Run: `npm run build` → no errors.

- [ ] **Step 4: Commit + merge**

```bash
git add -A
git commit -m "phase 0: spike findings, spec amendments, readme"
git checkout main
git merge --no-ff phase-0-scaffold -m "merge phase-0-scaffold"
git branch -d phase-0-scaffold
```

Then create the public repo (user said public, MIT):
```bash
gh repo create merttoka/point-cloud-editor --public --source=. --remote=origin --push
```

---

## Self-review notes

- Spec coverage for phase 0 (§7 item 0): scaffold ✓ (T1), MIT ✓ (T1), pinned deps ✓ (T1), packed-position attribute ✓ (T3), sized points mechanism + cost ✓ (T3, T5), compute writes storage Three renders ✓ (T4), timestamp query ✓ (T4), findings → ARCHITECTURE ✓ (T3–T5), spec revision gate ✓ (T6).
- `uint16x4` in the spec is superseded by `uint32x2` words; T6 Step 1.1 fixes the spec. Format helpers (T1) already reflect words.
- Names used across tasks: `makeSyntheticCloud`, `SyntheticCloud.words`, `packWords/unpackWords`, `buildFlagsCompute`, `spikeParams`, `__spike.fc` — consistent.
