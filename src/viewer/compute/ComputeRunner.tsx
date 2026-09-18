import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import type { ViewerApi } from '../render/Scene'
import { useViewerStore } from '../state/store'
import { dequantScale } from '../format/quant'
import { buildGrid, decodePositions } from './cpu/hash'
import { createComputePipeline } from './pipeline'

// Owns the compute pipeline (needs the renderer, so it lives inside <Canvas>) and exposes build/readback on the api.
export function ComputeRunner({ buffers, manifest, api }: { buffers: PointBuffers; manifest: Manifest; api: ViewerApi }) {
  const gl = useThree((s) => s.gl)
  const store = useViewerStore()

  useLayoutEffect(() => {
    const p = createComputePipeline(gl as unknown as THREE.WebGPURenderer, buffers, manifest)
    api.build = async (radius) => {
      if (store.get().compute.status === 'running') return
      store.set({ compute: { ...store.get().compute, status: 'running', error: undefined } })
      const t0 = performance.now()
      try {
        const timings = await p.build(radius)
        store.set({ compute: { ...store.get().compute, status: 'built', timings, elapsedMs: performance.now() - t0, builtRadius: radius } })
      } catch (err) {
        store.set({ compute: { ...store.get().compute, status: 'error', error: String(err) } })
      }
    }
    api.readback = () => p.readback()
    if (import.meta.env.DEV) {
      // CPU oracle over the same qpos words (compute/cpu/hash) for the browser spike / Verify.
      const cpuCellStart = (radius: number) =>
        buildGrid(decodePositions(buffers.qpos.array as Uint32Array, buffers.count, dequantScale(manifest.bounds)), buffers.count, radius, p.tableSize).cellStart
      ;(window as unknown as { __pcvCompute?: unknown }).__pcvCompute = {
        build: api.build, readback: api.readback, tableSize: p.tableSize, timings: () => store.get().compute.timings, state: () => store.get().compute, cpuCellStart,
      }
    }
    return () => {
      api.build = undefined; api.readback = undefined
      if (import.meta.env.DEV) delete (window as unknown as { __pcvCompute?: unknown }).__pcvCompute
      p.dispose()
    }
  }, [gl, buffers, manifest, api, store])

  return null
}
