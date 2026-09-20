import { useEffect, useRef, useState } from 'react'
import { centroidOf, fetchManifest, type Manifest } from './manifest'
import type { LoaderIn, LoaderOut } from './fetchChunks'
import type { ChunkRef } from './chunkQueue'
import { createPointBuffers, type PointBuffers } from '../render/PointBuffers'
import { createPointMaterial, type PointMaterialHandle } from '../render/pointMaterial'
import { createEditor, type Editor } from '../edit/editor'
import { useViewerStore } from '../state/store'
import { homePose, type ViewerApi } from '../render/Scene'
import { BENCH_CAP, benchWords, tableSizeFor } from '../compute/params'
import { dequantScale, WORDS_PER_POINT } from '../format/quant'
import { cpuLasso, cpuPick, decodeWorld, projectPoint } from '../edit/project'
import { packPoly, type Poly } from '../edit/lasso'
import { FLAG_DELETED, FLAG_HIDDEN } from '../edit/flags'

type BenchResult = { normals: Uint32Array; ao: Uint8Array; n: number } | null

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface Loaded {
  manifest: Manifest
  binUrl: string
  buffers: PointBuffers
  handle: PointMaterialHandle
  editor: Editor
}

export function useLoader(manifestUrl: string, api: ViewerApi): Loaded | null {
  const store = useViewerStore()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const uploadLog = useRef<number[]>([])

  useEffect(() => {
    let cancelled = false
    store.set({ status: 'loading', error: undefined, manifest: null, loaded: { points: 0, chunks: 0 } })
    fetchManifest(manifestUrl).then(({ manifest, binUrl }) => {
      if (cancelled) return
      const buffers = createPointBuffers(manifest.pointCount, manifest.chunks.length)
      const handle = createPointMaterial(buffers, manifest, store.get())
      const editor = createEditor(buffers, manifest, store)
      store.set({ manifest })
      setLoaded({ manifest, binUrl, buffers, handle, editor })
    }).catch((err: unknown) => {
      if (!cancelled) store.set({ status: 'error', error: String(err) })
    })
    return () => { cancelled = true }
  }, [store, manifestUrl])

  useEffect(() => {
    if (!loaded) return
    const { manifest, binUrl, buffers, editor } = loaded
    const centroid = centroidOf(manifest.bounds)
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' })
    const chunks: ChunkRef[] = manifest.chunks.map((c, index) => {
      const cc = centroidOf(c.bounds)
      return { index, offset: c.offset, count: c.count, centre: [cc[0] - centroid[0], cc[1] - centroid[1], cc[2] - centroid[2]] }
    })
    let points = 0, n = 0
    let benchResolve: ((r: BenchResult) => void) | null = null
    let benchN = 0
    let exportT0 = 0
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
        if (import.meta.env.DEV) {
          const w = window as unknown as { __pcvEdit?: { lastExport?: unknown } }
          if (w.__pcvEdit) w.__pcvEdit.lastExport = { count: msg.count, bytes: msg.zip.byteLength, ms: performance.now() - exportT0 }
        }
        download(msg.zip, 'export.zip')
        store.set({ edit: { ...store.get().edit, busy: false, message: `exported ${msg.count.toLocaleString()} points` } })
      } else if (msg.type === 'exportError') {
        store.set({ edit: { ...store.get().edit, busy: false, message: `export failed: ${msg.message}` } })
      } else if (msg.type === 'chunk') {
        const t0 = performance.now()
        buffers.uploadRange(manifest.chunks[msg.index].offset, msg.words)
        uploadLog.current.push(performance.now() - t0)
        buffers.loaded[msg.index] = 1
        points += manifest.chunks[msg.index].count
        n += 1
        store.set({ loaded: { points, chunks: n } })
      } else if (msg.type === 'done') {
        store.set({ status: 'ready' })
        api.sendCamera = undefined
        if (import.meta.env.DEV) (window as unknown as { __pcvUploadMs?: number[] }).__pcvUploadMs = uploadLog.current
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
      const edit = store.get().edit
      if (edit.busy) return
      exportT0 = performance.now()
      store.set({ edit: { ...edit, busy: true, message: undefined } })
      try {
        // Copies: the attribute's own array and the flags mirror must stay behind; the worker takes ownership of the slices.
        const m: LoaderIn = { type: 'export', words: (buffers.qpos.array as Uint32Array).slice(), flags: buffers.flagBytes.slice(), manifest }
        worker.postMessage(m, [m.words.buffer, m.flags.buffer])
      } catch (err) {
        // A synchronous postMessage failure would otherwise leave the toolbar locked behind `busy`.
        store.set({ edit: { ...store.get().edit, busy: false, message: `export failed: ${String(err)}` } })
      }
    }
    if (import.meta.env.DEV) {
      const w = window as unknown as { __pcvBench?: unknown; __pcvEdit?: unknown }
      w.__pcvBench = { state: () => store.get().bench, run: api.cpuBench }
      // CPU reference for the GPU select kernels: same matrices (api.viewParams from EditRunner), same visibility rule
      // (not hidden/deleted, inside the chunk's budget prefix), same attenuated radius as pickDepth.
      const dq = dequantScale(manifest.bounds), b = manifest.bounds
      const dqMin: [number, number, number] = [b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]]
      const q = buffers.qpos.array as Uint32Array
      const ref = () => {
        const v = api.viewParams!()
        const end = new Uint32Array(manifest.chunks.length)
        manifest.chunks.forEach((ch, k) => { end[k] = ch.offset + (buffers.loaded[k] ? Math.ceil(ch.count * v.budget) : 0) })
        const chunkOf = (i: number) => { let lo = 0, hi = manifest.chunks.length; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (manifest.chunks[m].offset <= i) lo = m; else hi = m }; return lo }
        const visible = (i: number) => (buffers.flagBytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && i < end[chunkOf(i)]
        const m = v.view.elements
        const radiusPx = (i: number) => {
          const [x, y, z] = decodeWorld(q, i, dq, dqMin)
          const viewZ = m[2] * x + m[6] * y + m[10] * z + m[14]
          return Math.max(3, Math.min(8, Math.max(1, v.pointSize * v.refDist / -viewZ)))
        }
        return { v, vp: v.viewProj.elements, visible, radiusPx }
      }
      api.cpuPick = (x, y) => { const r = ref(); return cpuPick(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, x, y, r.visible, r.radiusPx) }
      api.cpuLasso = (poly: Poly) => { const r = ref(); const { data, count } = packPoly(poly); return cpuLasso(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, data, count, r.visible) }
      const depthOf = (i: number) => { const r = ref(); const [x, y, z] = decodeWorld(q, i, dq, dqMin); return projectPoint(x, y, z, r.vp, r.v.width, r.v.height)?.[2] ?? null }
      w.__pcvEdit = { editor, buffers, api, store, state: () => store.get().edit, cpuPick: api.cpuPick, cpuLasso: api.cpuLasso, depthOf }
    }
    return () => {
      const m: LoaderIn = { type: 'dispose' }
      worker.postMessage(m)
      worker.onmessage = null
      worker.terminate()
      api.sendCamera = undefined
      api.cpuBench = undefined; api.cancelBench = undefined; api.exportZip = undefined
      benchResolve?.(null); benchResolve = null
      // Terminating mid-export drops its exportDone; release the gate so a new dataset's toolbar isn't locked.
      if (store.get().edit.busy) store.set({ edit: { ...store.get().edit, busy: false } })
      if (import.meta.env.DEV) {
        const w = window as unknown as { __pcvBench?: unknown; __pcvEdit?: unknown }
        delete w.__pcvBench; delete w.__pcvEdit
        api.cpuPick = undefined; api.cpuLasso = undefined
      }
    }
  }, [loaded, store, api])

  useEffect(() => () => { loaded?.editor.dispose(); loaded?.handle.dispose(); loaded?.buffers.dispose() }, [loaded])

  return loaded
}
