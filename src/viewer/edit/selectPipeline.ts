import * as THREE from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, uniform, vec3, type wgslFn } from 'three/tsl'
import type { PointBuffers } from '../render/PointBuffers'
import { centroidOf, type Manifest } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import type { SelectMode } from '../state/store'
import { timedCompute } from '../compute/timing'
import { resetPick, pickDepth, pickIndex, lassoSelect, LASSO_POLY_WORDS } from '../compute/wgsl/select'
import { polyBounds, MAX_LASSO_VERTS } from './lasso'

export interface ViewParams { viewProj: THREE.Matrix4; view: THREE.Matrix4; width: number; height: number; pointSize: number; refDist: number; budget: number }
export interface SelectPipeline {
  pick(x: number, y: number, v: ViewParams): Promise<{ index: number | null; ms: number }>
  lasso(poly: Float32Array, count: number, mode: SelectMode, v: ViewParams): Promise<{ gpuMs: number | null; readbackMs: number }>
  dispose(): void
}

type Kernel = ReturnType<typeof wgslFn>
const call = (fn: Kernel, args: Record<string, Node | number>) => (fn(args as Parameters<Kernel>[0]) as Node<'uint'>).toVar()
const MODE: Record<SelectMode, number> = { replace: 0, add: 1, subtract: 2 }
const MISS = 0xffffffff

export function createSelectPipeline(renderer: THREE.WebGPURenderer, buffers: PointBuffers, manifest: Manifest): SelectPipeline {
  const N = buffers.count, words = Math.ceil(N / 4), chunks = manifest.chunks.length
  const b = manifest.bounds, c = centroidOf(b)
  const pickAttr = new THREE.StorageBufferAttribute(new Uint32Array(2), 1)
  const polyAttr = new THREE.StorageBufferAttribute(new Float32Array(LASSO_POLY_WORDS), 2)
  const chunkAttr = new THREE.StorageBufferAttribute(new Uint32Array(chunks * 2), 2)
  const pick = storage(pickAttr, 'uint', 2).toAtomic() as StorageBufferNode<'uint'>
  const poly = storage(polyAttr, 'vec2', MAX_LASSO_VERTS)
  const chunkTable = storage(chunkAttr, 'uvec2', chunks)
  const u = {
    viewProj: uniform(new THREE.Matrix4()), view: uniform(new THREE.Matrix4()),
    viewport: uniform(new THREE.Vector2()), cursor: uniform(new THREE.Vector2()),
    pointSize: uniform(2), refDist: uniform(1000), vertexCount: uniform(0, 'uint'), mode: uniform(0, 'uint'), bbox: uniform(new THREE.Vector4()),
  }
  const common = {
    qpos: buffers.qposNode, flags: buffers.flagsNode, chunkTable, count: uint(N), chunks: uint(chunks),
    dqScale: vec3(...dequantScale(b)), dqMin: vec3(b.min[0] - c[0], b.min[1] - c[1], b.min[2] - c[2]),
    viewProj: u.viewProj, viewport: u.viewport,
  }
  const pickArgs = { ...common, pick, view: u.view, cursor: u.cursor, pointSize: u.pointSize, refDist: u.refDist, i: instanceIndex }
  const kReset = Fn(() => call(resetPick, { pick, i: instanceIndex }))().compute(2, [1])
  const kDepth = Fn(() => call(pickDepth, pickArgs))().compute(N, [64])
  const kIndex = Fn(() => call(pickIndex, pickArgs))().compute(N, [64])
  const kLasso = Fn(() => call(lassoSelect, { ...common, poly, w: instanceIndex, vertexCount: u.vertexCount, mode: u.mode, bbox: u.bbox }))().compute(words, [64])

  const setView = (v: ViewParams) => {
    u.viewProj.value.copy(v.viewProj); u.view.value.copy(v.view)
    u.viewport.value.set(v.width, v.height); u.pointSize.value = v.pointSize; u.refDist.value = v.refDist
    const t = chunkAttr.array as Uint32Array
        // Unloaded chunks draw 0 instances (ChunkSprites), so they must not be pickable either.
    manifest.chunks.forEach((ch, k) => { t[k * 2] = ch.offset; t[k * 2 + 1] = ch.offset + (buffers.loaded[k] ? Math.ceil(ch.count * v.budget) : 0) })
    chunkAttr.needsUpdate = true
  }

  return {
    async pick(x, y, v) {
      const t0 = performance.now()
      setView(v); u.cursor.value.set(x, y)
      await renderer.computeAsync(kReset)
      await renderer.computeAsync(kDepth)
      await renderer.computeAsync(kIndex)
      const out = new Uint32Array(await renderer.getArrayBufferAsync(pickAttr))
      return { index: out[1] === MISS ? null : out[1], ms: performance.now() - t0 }
    },
    async lasso(polyData, count, mode, v) {
      setView(v)
      ;(polyAttr.array as Float32Array).set(polyData); polyAttr.needsUpdate = true
      u.vertexCount.value = count; u.mode.value = MODE[mode]
      const [minX, minY, maxX, maxY] = polyBounds(polyData, count); u.bbox.value.set(minX, minY, maxX, maxY)
      const { gpuMs } = await timedCompute(renderer, kLasso, 'lasso')
      const t0 = performance.now()
      const buf = await renderer.getArrayBufferAsync(buffers.flags)
      ;(buffers.flags.array as Uint32Array).set(new Uint32Array(buf))      // mirror ← GPU; no needsUpdate (A5)
      return { gpuMs, readbackMs: performance.now() - t0 }
    },
    dispose() { for (const n of [pick, poly, chunkTable, kReset, kDepth, kIndex, kLasso]) n.dispose() },
  }
}
