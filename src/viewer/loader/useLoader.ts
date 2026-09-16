import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchManifest, type Manifest } from './manifest'
import type { LoaderIn, LoaderOut } from './fetchChunks'
import type { ChunkRef } from './chunkQueue'
import { createPointBuffers, type PointBuffers } from '../render/PointBuffers'
import { createPointMaterial, type PointMaterialHandle } from '../render/pointMaterial'
import { centroidOf } from '../render/ChunkSprites'
import type { Store, ViewerState } from '../state/store'
import { fitDistance, type ViewerApi } from '../render/Scene'

export interface Loaded {
  manifest: Manifest
  binUrl: string
  buffers: PointBuffers
  handle: PointMaterialHandle
  centroid: [number, number, number]
}

export function useLoader(store: Store<ViewerState>, manifestUrl: string, api: ViewerApi): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const uploadLog = useRef<number[]>([])

  useEffect(() => {
    let cancelled = false
    store.set({ status: 'loading', error: undefined, manifest: null, loaded: { points: 0, chunks: 0 } })
    fetchManifest(manifestUrl).then(({ manifest, binUrl }) => {
      if (cancelled) return
      const centroid = centroidOf(manifest.bounds)
      const buffers = createPointBuffers(manifest.pointCount, manifest.chunks.length)
      const handle = createPointMaterial(buffers, manifest, centroid)
      store.set({ manifest })
      setLoaded({ manifest, binUrl, buffers, handle, centroid })
    }).catch((err: unknown) => {
      if (!cancelled) store.set({ status: 'error', error: String(err) })
    })
    return () => { cancelled = true }
  }, [store, manifestUrl])

  useEffect(() => {
    if (!loaded) return
    const { manifest, binUrl, buffers, centroid } = loaded
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })
    const chunks: ChunkRef[] = manifest.chunks.map((c, index) => {
      const cc = centroidOf(c.bounds)
      return { index, offset: c.offset, count: c.count, centre: [cc[0] - centroid[0], cc[1] - centroid[1], cc[2] - centroid[2]] }
    })
    let points = 0, n = 0
    worker.onmessage = (e: MessageEvent<LoaderOut>) => {
      const msg = e.data
      if (msg.type === 'chunk') {
        const t0 = performance.now()
        buffers.uploadRange(manifest.chunks[msg.index].offset, msg.words)
        uploadLog.current.push(performance.now() - t0)
        buffers.loaded[msg.index] = 1
        points += manifest.chunks[msg.index].count
        n += 1
        store.set({ loaded: { points, chunks: n } })
        if (import.meta.env.DEV) console.debug(`[loader] chunk ${msg.index} (${manifest.chunks[msg.index].count} pts) ${n}/${manifest.chunks.length}`)
      } else if (msg.type === 'done') {
        store.set({ status: 'ready' })
        if (import.meta.env.DEV) (window as unknown as { __pcvUploadMs?: number[] }).__pcvUploadMs = uploadLog.current
      } else {
        store.set({ status: 'error', error: msg.message })
      }
    }
    // Seed the queue with the same initial camera the scene fits to (centred frame, target origin)
    // so the first chunks fetched are the ones the camera is actually looking at.
    const fov = 50
    const dist = fitDistance(manifest, fov)
    const dx = 1, dy = -1, dz = 0.8
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const initPos: [number, number, number] = [(dx / mag) * dist, (dy / mag) * dist, (dz / mag) * dist]
    const start: LoaderIn = { type: 'start', binUrl, chunks, pos: initPos }
    worker.postMessage(start)
    api.sendCamera = (pos) => { const m: LoaderIn = { type: 'camera', pos }; worker.postMessage(m) }
    return () => {
      const m: LoaderIn = { type: 'dispose' }
      worker.postMessage(m)
      worker.onmessage = null
      worker.terminate()
      api.sendCamera = undefined
    }
  }, [loaded, store, api])

  useEffect(() => () => { loaded?.handle.dispose(); loaded?.buffers.dispose() }, [loaded])

  return useMemo(() => loaded, [loaded])
}
