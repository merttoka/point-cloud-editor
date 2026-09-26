import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import { patchEdit, patchLayers, type SelectMode, type Segment, type Store, type ViewerState } from '../state/store'
import { allVisible, classBit, fillVisible, isVisible, setBit } from '../render/layerMasks'
import { dequantScale } from '../format/quant'
import { spacingOf } from '../compute/params'
import { scanFlags, unionRange, FLAG_SELECTED, FLAG_HIDDEN, FLAG_DELETED, type Range } from './flags'
import { createUndoRing } from './undo'
import * as ops from './ops'
import { ALL, claimSegment, countSegments, freeSegmentId, layerMember, releaseSegment, selectLayer as selectLayerBytes, SEGMENT_PALETTE, type Layer, type Vis } from './layers'
import { fitPlane, samplePoints, signedDistance } from './plane'

export interface Editor {
  bytes: Uint8Array                                   // = buffers.flagBytes
  ready(): boolean                                    // every chunk loaded and no GPU select / export in flight
  isolate(): void; hide(): void; del(): void; unhideAll(): void; clearSelection(): void   // side = store.edit.splitSide
  split(): void                                       // fit + tagSplit; sets edit.split, message on < 3 pts
  pick(idx: number | null, mode: SelectMode): void    // CPU apply of a GPU pick result (null = miss)
  beginGpuEdit(): void                                // snapshot the whole mirror for undo; busy until end/abort
  endGpuEdit(): void                                  // call once the readback has landed in `bytes`
  abortGpuEdit(): void                                // failed GPU select: GPU ← mirror, no undo entry
  undo(): void; redo(): void
  refresh(): void                                     // counts + depths → store
  segBytes: Uint8Array                                 // = buffers.segBytes
  // Layers. Segment table edits and visibility are outside the undo ring; selectLayer goes through it (whole-buffer push).
  saveSegment(name?: string): Segment | null
  deleteSegment(id: number): void
  renameSegment(id: number, name: string): void
  setSegmentColor(id: number, color: string): void
  setLayerVisible(layer: Layer, visible: boolean): void
  soloLayer(layer: Layer): void
  showAllLayers(): void
  selectLayer(layer: Layer, mode: SelectMode): void
  dispose(): void
}

const PLANE_SAMPLE_CAP = 50_000
const PLANE_THRESHOLD_MUL = 2          // inlier threshold = 2 × mean point spacing

export function createEditor(buffers: PointBuffers, manifest: Manifest, store: Store<ViewerState>): Editor {
  const bytes = buffers.flagBytes
  const N = buffers.count
  const undo = createUndoRing(bytes)
  const dq = dequantScale(manifest.bounds)
  const q = buffers.qpos.array as Uint32Array
  const seg = buffers.segBytes
  const masks = buffers.masks
  const layers = () => store.get().layers
  // Layer visibility of point i (class bit ∧ segment bit); identity while nothing is masked so unmasked ops keep phase 5's cost.
  const layerOk = (i: number) => isVisible(masks.words, q[i * 2 + 1] >>> 24, seg[i])
  const maskVis = (): Vis => allVisible(masks.words) ? ALL : layerOk
  let selRange: Range | null = null
  const patch = (p: Partial<ViewerState['edit']>) => patchEdit(store, p)
  const ready = () => store.get().status === 'ready' && !store.get().edit.busy
  const side = () => store.get().edit.splitSide

  const refresh = () => {
    const scan = scanFlags(bytes)
    selRange = scan.selRange
    const { split, splitSide } = store.get().edit
    // Tags gone (undo, replace lasso, clear, hide, delete): a stale side filter would make every op a silent no-op.
    const stale = scan.counts.split === 0 && (split.fitted || splitSide !== 'all')
    patch({ counts: scan.counts, undoDepth: undo.undoDepth(), redoDepth: undo.redoDepth(), ...(stale && { split: { fitted: false, inlierRatio: null }, splitSide: 'all' }) })
    const segs = layers().segments
    if (segs.length > 0) {
      const c = countSegments(seg, bytes, N)
      if (segs.some((s) => s.count !== c[s.id])) patchLayers(store, { segments: segs.map((s) => s.count === c[s.id] ? s : { ...s, count: c[s.id] }) })
    }
  }
  // Whole-buffer ops: push N bytes first, drop the command again if nothing changed.
  // noopMessage: shown when the op found nothing to do but points were selected (masked out) — silent otherwise.
  const run = (pushRange: Range, op: () => Range | null, noopMessage?: string) => {
    if (!ready()) return
    undo.push(pushRange.min, pushRange.max)
    const r = op()
    if (!r) { undo.dropLast(); if (noopMessage && store.get().edit.counts.selected > 0) patch({ message: noopMessage }); return }
    buffers.uploadFlagsRange(r.min, r.max)
    refresh()
  }
  const all: Range = { min: 0, max: N - 1 }
  const clearSel = () => { if (selRange) run(selRange, () => ops.clearSelection(bytes, selRange)) }
  const apply = (r: Range | null) => { if (r) { buffers.uploadFlagsRange(r.min, r.max); refresh() } }

  // Bounds-relative position of point i (the compute kernels' frame).
  const decodeScaled = (i: number, out: Float32Array, k: number) => {
    const w0 = q[i * 2], w1 = q[i * 2 + 1]
    out[k] = (w0 & 0xffff) * dq[0]; out[k + 1] = (w0 >>> 16) * dq[1]; out[k + 2] = (w1 & 0xffff) * dq[2]
  }
  const selectedPositions = () => {
    const vis = maskVis()
    let n = 0
    for (let i = 0; i < N; i++) if ((bytes[i] & FLAG_SELECTED) && vis(i)) n++
    const pts = new Float32Array(n * 3)
    for (let i = 0, k = 0; i < N; i++) if ((bytes[i] & FLAG_SELECTED) && vis(i)) { decodeScaled(i, pts, k); k += 3 }
    return { pts, n }
  }

  const segWord = (id: number) => 1 + (id >> 5)
  const setMaskSegment = (id: number, on: boolean) => setBit(masks.words, segWord(id), id & 31, on)
  const setMaskClass = (cls: number, on: boolean) => setBit(masks.words, 0, classBit(cls), on)
  const patchSegment = (id: number, p: Partial<Segment>) => patchLayers(store, { segments: layers().segments.map((s) => s.id === id ? { ...s, ...p } : s) })
  const classVisibleAll = (on: boolean) => Object.fromEntries(Object.keys(layers().classCounts).map((c) => [c, on])) as Record<number, boolean>

  return {
    bytes,
    ready,
    isolate: () => run(all, () => ops.isolate(bytes, side(), maskVis()), 'No visible selected points.'),
    hide: () => run(all, () => ops.hide(bytes, side(), maskVis()), 'No visible selected points.'),
    del: () => run(all, () => ops.del(bytes, side(), maskVis()), 'No visible selected points.'),
    unhideAll: () => run(all, () => ops.unhideAll(bytes)),
    clearSelection: clearSel,
    pick(idx, mode) {
      if (idx === null) { if (mode === 'replace') clearSel(); return }
      const r = unionRange(mode === 'replace' ? selRange : null, { min: idx, max: idx })!
      run(r, () => ops.applyPick(bytes, idx, mode, selRange))
    },
    split() {
      if (!ready()) return
      const sel = selectedPositions()
      if (sel.n < 3) { patch({ message: 'Split needs at least 3 selected points.', split: { fitted: false, inlierRatio: null } }); return }
      const sample = samplePoints(sel.pts, sel.n, PLANE_SAMPLE_CAP)
      const plane = fitPlane(sample.pts, sample.n, PLANE_THRESHOLD_MUL * spacingOf(manifest.bounds, manifest.pointCount))
      if (!plane) { patch({ message: 'Plane fit failed (degenerate selection).', split: { fitted: false, inlierRatio: null } }); return }
      const p = new Float32Array(3)
      const sideA = (i: number) => { decodeScaled(i, p, 0); return signedDistance(plane, p[0], p[1], p[2]) >= 0 }
      run(all, () => ops.tagSplit(bytes, sideA))
      patch({ message: undefined, split: { fitted: true, inlierRatio: plane.inlierRatio } })
    },
    beginGpuEdit() { undo.push(0, N - 1); patch({ busy: true }) },
    endGpuEdit() { patch({ busy: false }); refresh() },
    abortGpuEdit() {
      // The kernel may have run before the readback failed: the mirror is the source of truth, so push it back to the GPU.
      buffers.uploadFlagsRange(0, N - 1)
      undo.dropLast(); patch({ busy: false }); refresh()
    },
    undo() { if (ready()) apply(undo.undo()) },
    redo() { if (ready()) apply(undo.redo()) },
    refresh,
    segBytes: seg,
    saveSegment(name) {
      if (!ready()) return null
      const segs = layers().segments
      const id = freeSegmentId(segs.map((s) => s.id))
      if (id === null) { patch({ message: 'All 255 segment ids are in use.' }); return null }
      const r = claimSegment(seg, bytes, N, id, side(), maskVis())
      if (!r.range) { patch({ message: 'No visible selected points.' }); return null }
      buffers.uploadSegRange(r.range.min, r.range.max)
      setMaskSegment(id, true); masks.upload()          // a reused id starts visible
      const s: Segment = { id, name: name ?? `Segment ${id}`, color: SEGMENT_PALETTE[(id - 1) % SEGMENT_PALETTE.length], count: r.count, visible: true }
      patchLayers(store, { segments: [...segs, s] })
      patch({ message: undefined })
      clearSel()                                         // new colour shows at once; run() inside refreshes
      if (!selRange) refresh()                            // clearSel is a no-op with nothing selected — recount anyway
      return s
    },
    deleteSegment(id) {
      if (!ready()) return
      const r = releaseSegment(seg, N, id)
      if (r) buffers.uploadSegRange(r.min, r.max)
      // Freed points return to id 0 (unsegmented): both bits must be visible, or a solo on this segment hides them.
      setMaskSegment(id, true); setMaskSegment(0, true); masks.upload()
      patchLayers(store, { segments: layers().segments.filter((s) => s.id !== id) })
    },
    renameSegment(id, name) { patchSegment(id, { name }) },
    setSegmentColor(id, color) { patchSegment(id, { color }) },
    setLayerVisible(layer, on) {
      if ('class' in layer) { setMaskClass(layer.class, on); patchLayers(store, { classVisible: { ...layers().classVisible, [layer.class]: on } }) }
      else { setMaskSegment(layer.segment, on); patchSegment(layer.segment, { visible: on }) }
      masks.upload()
    },
    soloLayer(layer) {
      fillVisible(masks.words)
      if ('class' in layer) {
        masks.words[0] = 0; setMaskClass(layer.class, true)
        patchLayers(store, { classVisible: { ...classVisibleAll(false), [layer.class]: true }, segments: layers().segments.map((s) => s.visible ? s : { ...s, visible: true }) })
      } else {
        masks.words.fill(0, 1); setMaskSegment(layer.segment, true)
        patchLayers(store, { classVisible: classVisibleAll(true), segments: layers().segments.map((s) => ({ ...s, visible: s.id === layer.segment })) })
      }
      masks.upload()
    },
    showAllLayers() {
      fillVisible(masks.words); masks.upload()
      patchLayers(store, { classVisible: classVisibleAll(true), segments: layers().segments.map((s) => s.visible ? s : { ...s, visible: true }) })
    },
    selectLayer(layer, mode) {
      const vis = maskVis()   // ALL fast path while nothing is masked, like isolate/hide/del
      const visOk = (i: number) => (bytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && vis(i)
      run(all, () => selectLayerBytes(bytes, N, layerMember(layer, q, seg), mode, visOk))
    },
    dispose() { undo.clear() },
  }
}
