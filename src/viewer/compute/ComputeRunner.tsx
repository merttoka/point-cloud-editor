import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import type { ViewerApi } from '../render/Scene'
import { useViewerStore } from '../state/store'
import { octDecode } from './cpu/normals'
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
    // Per-class |n.z| histogram (10 bins) and mean AO over the last build (bench handle).
    const classStats = async () => {
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
    }
    api.classStats = classStats
    return () => {
      api.build = undefined; api.readback = undefined; api.classStats = undefined
      p.dispose()
    }
  }, [gl, buffers, manifest, api, store])

  return null
}
