import { useEffect, useRef, useState } from 'react'
import { centroidOf, fetchManifest, type Manifest } from './manifest'
import type { LoaderIn, LoaderOut } from './fetchChunks'
import type { ChunkRef } from './chunkQueue'
import { createPointBuffers, type PointBuffers } from '../render/PointBuffers'
import { createPointMaterial, type PointMaterialHandle } from '../render/pointMaterial'
import { createEditor, type Editor } from '../edit/editor'
import { applySegmentBytes, classCounts } from '../edit/layers'
import { initialState, patchEdit, useViewerStore, type Segment } from '../state/store'
import { homePose, type ViewerApi } from '../render/Scene'
import { BENCH_CAP, benchWords, tableSizeFor } from '../compute/params'
import { dequantScale, WORDS_PER_POINT } from '../format/quant'
import { download } from '../ui/download'

type BenchResult = { normals: Uint32Array; ao: Uint8Array; n: number } | null

export interface Loaded {
  manifest: Manifest
  binUrl: string
  segmentsUrl: string | null
  buffers: PointBuffers
  handle: PointMaterialHandle
  editor: Editor
}

export function useLoader(manifestUrl: string, api: ViewerApi): Loaded | null {
  const store = useViewerStore()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const uploadLog = useRef<number[]>([])
  const loadT0 = useRef(0)   // manifest fetch start; read when the worker reports done

  useEffect(() => {
    let cancelled = false
    store.set({ status: 'loading', error: undefined, manifest: null, loaded: { points: 0, chunks: 0 }, loadMs: null, layers: initialState.layers })
    loadT0.current = performance.now()
    fetchManifest(manifestUrl).then(({ manifest, binUrl, segmentsUrl }) => {
      if (cancelled) return
      const buffers = createPointBuffers(manifest.pointCount, manifest.chunks.length)
      const handle = createPointMaterial(buffers, manifest, store.get())
      const editor = createEditor(buffers, manifest, store)
      store.set({ manifest })
      setLoaded({ manifest, binUrl, segmentsUrl, buffers, handle, editor })
    }).catch((err: unknown) => {
      if (!cancelled) store.set({ status: 'error', error: String(err) })
    })
    return () => { cancelled = true }
  }, [store, manifestUrl])

  useEffect(() => {
    if (!loaded) return
    const { manifest, binUrl, buffers, segmentsUrl } = loaded
    const t0 = loadT0.current   // this dataset's; a later manifestUrl swap must not re-base a still-streaming worker's loadMs
    const centroid = centroidOf(manifest.bounds)
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })
    const chunks: ChunkRef[] = manifest.chunks.map((c, index) => {
      const cc = centroidOf(c.bounds)
      return { index, offset: c.offset, count: c.count, centre: [cc[0] - centroid[0], cc[1] - centroid[1], cc[2] - centroid[2]] }
    })
    let points = 0, n = 0
    let disposed = false
    let benchResolve: ((r: BenchResult) => void) | null = null
    let benchN = 0
    // Class counts once (one pass over the words, ~30 ms at 20M) and the exported segment table, both before `ready` so the
    // Layers card never shows zeros. A missing/short segments.bin only costs the segments (warned), never the dataset.
    const finish = async () => {
      try {
        const counts = classCounts(buffers.qpos.array as Uint32Array, manifest.pointCount)
        let segments: Segment[] = []
        const table = manifest.segments ?? []
        if (table.length > 0 && segmentsUrl) {
          try {
            const res = await fetch(segmentsUrl)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const bytes = new Uint8Array(await res.arrayBuffer())
            if (bytes.length !== manifest.pointCount) throw new Error(`${bytes.length} bytes for ${manifest.pointCount} points`)
            const r = applySegmentBytes(buffers.segBytes, bytes, table)
            if (r.unknown > 0) console.warn(`segments: dropped ${r.unknown} points whose id is not in the manifest table`)
            if (!disposed) buffers.uploadSegRange(0, manifest.pointCount - 1)
            segments = r.segments
          } catch (err) { console.warn(`segments: ${String(err)} (${segmentsUrl}); opening without segments`) }
        } else if (table.length > 0 || segmentsUrl) {
          console.warn(`segments: ${table.length > 0 ? 'manifest.segments present but no segmentsUrl' : 'segmentsUrl present but no manifest.segments'}; opening without segments`)
        }
        if (disposed) return
        store.set({ layers: { classCounts: counts, classVisible: {}, segments }, status: 'ready', loadMs: performance.now() - t0 })
        api.sendCamera = undefined
      } catch (err) {
        // Mirrors the worker's own 'error' branch below — a throw outside the segments block (e.g. classCounts) must not
        // silently strand the dataset in 'loading'.
        if (!disposed) store.set({ status: 'error', error: String(err) })
      }
    }
    worker.onmessage = (e: MessageEvent<LoaderOut>) => {
      const msg = e.data
      if (msg.type === 'benchProgress') {
        store.set({ bench: { ...store.get().bench, progress: msg.frac } })
      } else if (msg.type === 'benchDone') {
        store.set({ bench: { ...store.get().bench, status: 'done', progress: 1, cpuMs: msg.ms } })
        benchResolve?.({ normals: msg.normals, ao: msg.ao, n: benchN }); benchResolve = null
      } else if (msg.type === 'benchCancelled') {
        store.set({ bench: { ...store.get().bench, status: 'cancelled' } })
        benchResolve?.(null); benchResolve = null
      } else if (msg.type === 'exportDone') {
        download(new Blob([msg.zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'export.zip')
        patchEdit(store, { busy: false, message: `exported ${msg.count.toLocaleString()} points` })
      } else if (msg.type === 'exportError') {
        patchEdit(store, { busy: false, message: `export failed: ${msg.message}` })
      } else if (msg.type === 'chunk') {
        const t0 = performance.now()
        buffers.uploadRange(manifest.chunks[msg.index].offset, msg.words)
        uploadLog.current.push(performance.now() - t0)
        buffers.loaded[msg.index] = 1
        points += manifest.chunks[msg.index].count
        n += 1
        store.set({ loaded: { points, chunks: n } })
      } else if (msg.type === 'done') {
        void finish()
      } else if (n > 0) {
        // Scene already has geometry on screen — don't tear it down, just surface the error.
        store.set({ error: msg.message })
      } else {
        store.set({ status: 'error', error: msg.message })
      }
    }
    // Seed the queue with the pose the scene fits to, so the first chunks fetched are the ones in view.
    const start: LoaderIn = { type: 'start', binUrl, chunks, pos: homePose(manifest).pos }
    worker.postMessage(start)
    api.sendCamera = (pos) => { const m: LoaderIn = { type: 'camera', pos }; worker.postMessage(m) }
    api.uploadLog = () => uploadLog.current.slice()
    api.cpuBench = (radius) => {
      if (benchResolve) return Promise.resolve(null)
      const words = benchWords(buffers.qpos.array as Uint32Array, manifest.chunks, Math.min(manifest.pointCount, BENCH_CAP))
      benchN = words.length / WORDS_PER_POINT
      store.set({ bench: { status: 'running', progress: 0, n: benchN, cpuMs: null, verify: null } })
      // Never transfer the attribute's own array: benchWords returns it as-is when n covers every point.
      const m: LoaderIn = { type: 'cpuBench', words: words === buffers.qpos.array ? words.slice() : words, n: benchN, dqScale: dequantScale(manifest.bounds), radius, tableSize: tableSizeFor(benchN) }
      worker.postMessage(m, [m.words.buffer])
      return new Promise((resolve) => { benchResolve = resolve })
    }
    api.cancelBench = () => { const m: LoaderIn = { type: 'cancelBench' }; worker.postMessage(m) }
    api.exportZip = async () => {
      if (store.get().edit.busy) return
      patchEdit(store, { busy: true, message: undefined })
      try {
        // Copies: the attribute's own array, the flags mirror and the seg mirror must stay behind; the worker takes ownership of the slices.
        const segments = store.get().layers.segments.map(({ id, name, color }) => ({ id, name, color }))
        const seg = segments.length > 0 ? buffers.segBytes.slice() : new Uint8Array(0)   // no segments: skip the 20 MB copy, worker ignores it anyway
        const m: LoaderIn = { type: 'export', words: (buffers.qpos.array as Uint32Array).slice(), flags: buffers.flagBytes.slice(), seg, segments, manifest }
        worker.postMessage(m, [m.words.buffer, m.flags.buffer, m.seg.buffer])
      } catch (err) {
        // A synchronous postMessage failure would otherwise leave the toolbar locked behind `busy`.
        patchEdit(store, { busy: false, message: `export failed: ${String(err)}` })
      }
    }
    return () => {
      disposed = true
      const m: LoaderIn = { type: 'dispose' }
      worker.postMessage(m)
      worker.onmessage = null
      worker.terminate()
      api.sendCamera = undefined
      api.uploadLog = undefined
      api.cpuBench = undefined; api.cancelBench = undefined; api.exportZip = undefined
      benchResolve?.(null); benchResolve = null
      // Terminating mid-export drops its exportDone; release the gate so a new dataset's toolbar isn't locked.
      if (store.get().edit.busy) patchEdit(store, { busy: false })
    }
  }, [loaded, store, api])

  useEffect(() => () => { loaded?.editor.dispose(); loaded?.handle.dispose(); loaded?.buffers.dispose() }, [loaded])

  return loaded
}
