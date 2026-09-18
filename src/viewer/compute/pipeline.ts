import * as THREE from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, uniform, vec3, type wgslFn } from 'three/tsl'
import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import type { PassTiming } from '../state/store'
import { SCAN_BLOCK, tableSizeFor } from './params'
import { timedCompute } from './timing'
import { zeroCells, countCells, reduceBlocks, scanBlockSums, scanCells, scatterPoints } from './wgsl/hash'

export interface ComputeReadback { normals: Uint32Array; ao: Uint32Array; cellStart: Uint32Array }

export interface ComputePipeline {
  tableSize: number
  build(radius: number): Promise<PassTiming[]>
  readback(): Promise<ComputeReadback>
  dispose(): void
}

// wgslFn calls are typed as bare Node in @types/three (no .toVar); cast once here.
type Kernel = ReturnType<typeof wgslFn>
const call = (fn: Kernel, args: Record<string, Node | number>) => (fn(args as Parameters<Kernel>[0]) as Node<'uint'>).toVar()

export function createComputePipeline(renderer: THREE.WebGPURenderer, buffers: PointBuffers, manifest: Manifest): ComputePipeline {
  const N = buffers.count
  const T = tableSizeFor(N)
  const blocks = T / SCAN_BLOCK
  const cellStartAttr = new THREE.StorageBufferAttribute(new Uint32Array(T + 1), 1)
  const cellCursorAttr = new THREE.StorageBufferAttribute(new Uint32Array(T), 1)
  const blockSumsAttr = new THREE.StorageBufferAttribute(new Uint32Array(blocks), 1)
  const sortedAttr = new THREE.StorageBufferAttribute(new Uint32Array(N), 1)
  const cellStart = storage(cellStartAttr, 'uint', T + 1).toAtomic() as StorageBufferNode<'uint'>
  const cellCursor = storage(cellCursorAttr, 'uint', T).toAtomic() as StorageBufferNode<'uint'>
  const blockSums = storage(blockSumsAttr, 'uint', blocks)
  const sorted = storage(sortedAttr, 'uint', N)

  const dqScale = vec3(...dequantScale(manifest.bounds))
  const radius = uniform(1)
  const common = { qpos: buffers.qposNode, count: uint(N), dqScale, radius, mask: uint(T - 1) }

  const kZero = Fn(() => call(zeroCells, { cellStart, i: instanceIndex, n: uint(T + 1) }))().compute(T + 1, [64])
  const kCount = Fn(() => call(countCells, { ...common, cellStart, i: instanceIndex }))().compute(N, [64])
  const kReduce = Fn(() => call(reduceBlocks, { cellStart, blockSums, b: instanceIndex, blocks: uint(blocks) }))().compute(blocks, [64])
  const kScanSums = Fn(() => call(scanBlockSums, { blockSums, i: instanceIndex, blocks: uint(blocks) }))().compute(1, [1])
  const kScanCells = Fn(() => call(scanCells, { cellStart, cellCursor, blockSums, b: instanceIndex, blocks: uint(blocks), tableSize: uint(T) }))().compute(blocks, [64])
  const kScatter = Fn(() => call(scatterPoints, { ...common, cellCursor, sorted, i: instanceIndex }))().compute(N, [64])

  async function hashPasses(): Promise<PassTiming[]> {
    const out: PassTiming[] = []
    await renderer.computeAsync(kZero)                          // not timed: bookkeeping
    out.push(await timedCompute(renderer, kCount, 'count'))
    const r = await timedCompute(renderer, kReduce, 'scan')
    const s = await timedCompute(renderer, kScanSums, 'scan')
    const c = await timedCompute(renderer, kScanCells, 'scan')
    out.push({ pass: 'scan', submitMs: r.submitMs + s.submitMs + c.submitMs, gpuMs: r.gpuMs === null || s.gpuMs === null || c.gpuMs === null ? null : r.gpuMs + s.gpuMs + c.gpuMs })
    out.push(await timedCompute(renderer, kScatter, 'scatter'))
    return out
  }

  // getArrayBufferAsync throws if the attribute was never bound by a pipeline; an unbound buffer was never
  // written by the GPU, so its CPU-side array is the true content.
  async function readAttr(attr: THREE.StorageBufferAttribute): Promise<Uint32Array> {
    try { return new Uint32Array(await renderer.getArrayBufferAsync(attr)) } catch { return new Uint32Array(attr.array as Uint32Array) }
  }

  return {
    tableSize: T,
    async build(r) {
      radius.value = r
      return hashPasses()                                         // Task 5 appends normals + ao
    },
    async readback() {
      const [normals, ao, cellStart] = await Promise.all([readAttr(buffers.normals), readAttr(buffers.ao), readAttr(cellStartAttr)])
      return { normals, ao, cellStart }
    },
    dispose() { for (const n of [cellStart, cellCursor, blockSums, sorted]) n.dispose() },
  }
}
