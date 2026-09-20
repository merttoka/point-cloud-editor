import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import type { SelectMode, Store, ViewerState } from '../state/store'
import { dequantScale } from '../format/quant'
import { spacingOf } from '../compute/params'
import { countFlags, selectionRange, unionRange, FLAG_SELECTED, type Range } from './flags'
import { createUndoRing } from './undo'
import * as ops from './ops'
import { fitPlane, samplePoints, signedDistance } from './plane'

export interface Editor {
  bytes: Uint8Array                                   // = buffers.flagBytes
  isolate(): void; hide(): void; del(): void; unhideAll(): void; clearSelection(): void   // side = store.edit.splitSide
  split(): void                                       // fit + tagSplit; sets edit.split, message on < 3 pts
  pick(idx: number | null, mode: SelectMode): void    // CPU apply of a GPU pick result (null = miss)
  beginGpuEdit(): void                                // undo.push(0, N-1); store busy = true
  endGpuEdit(): void                                  // recount, selRange, busy = false (call after the readback landed in bytes)
  undo(): void; redo(): void
  refresh(): void                                     // counts + depths → store
  dispose(): void
}

const PLANE_SAMPLE_CAP = 50_000
const PLANE_THRESHOLD_MUL = 2          // inlier threshold = 2 × mean spacing (spec)

export function createEditor(buffers: PointBuffers, manifest: Manifest, store: Store<ViewerState>): Editor {
  const bytes = buffers.flagBytes
  const N = buffers.count
  const undo = createUndoRing(bytes)
  const dq = dequantScale(manifest.bounds)
  let selRange: Range | null = null
  const patch = (p: Partial<ViewerState['edit']>) => store.set({ edit: { ...store.get().edit, ...p } })
  const busy = () => store.get().edit.busy
  const side = () => store.get().edit.splitSide

  const refresh = () => {
    selRange = selectionRange(bytes)
    patch({ counts: countFlags(bytes), undoDepth: undo.undoDepth(), redoDepth: undo.redoDepth() })
  }
  // Whole-buffer ops: push N bytes first, drop the command again if nothing changed.
  const run = (pushRange: Range, op: () => Range | null) => {
    if (busy()) return
    undo.push(pushRange.min, pushRange.max)
    const r = op()
    if (!r) { undo.dropLast(); return }
    buffers.uploadFlagsRange(r.min, r.max)
    refresh()
  }
  const all: Range = { min: 0, max: N - 1 }
  const clearSel = () => { if (selRange) run(selRange, () => ops.clearSelection(bytes, selRange)) }

  // Bounds-relative positions of the selected points (same frame as the compute kernels), stride-sampled.
  const selectedPositions = () => {
    const idx: number[] = []
    for (let i = 0; i < N; i++) if (bytes[i] & FLAG_SELECTED) idx.push(i)
    const q = buffers.qpos.array as Uint32Array
    const pts = new Float32Array(idx.length * 3)
    idx.forEach((i, k) => {
      const w0 = q[i * 2], w1 = q[i * 2 + 1]
      pts[k * 3] = (w0 & 0xffff) * dq[0]; pts[k * 3 + 1] = (w0 >>> 16) * dq[1]; pts[k * 3 + 2] = (w1 & 0xffff) * dq[2]
    })
    return { pts, n: idx.length }
  }

  return {
    bytes,
    isolate: () => run(all, () => ops.isolate(bytes, side())),
    hide: () => run(all, () => ops.hide(bytes, side())),
    del: () => run(all, () => ops.del(bytes, side())),
    unhideAll: () => run(all, () => ops.unhideAll(bytes)),
    clearSelection: clearSel,
    pick(idx, mode) {
      if (idx === null) { if (mode === 'replace') clearSel(); return }
      const r = unionRange(mode === 'replace' ? selRange : null, { min: idx, max: idx })!
      run(r, () => ops.applyPick(bytes, idx, mode, selRange))
    },
    split() {
      if (busy()) return
      const sel = selectedPositions()
      if (sel.n < 3) { patch({ message: 'Split needs at least 3 selected points.', split: { fitted: false, inlierRatio: null } }); return }
      const sample = samplePoints(sel.pts, sel.n, PLANE_SAMPLE_CAP)
      const plane = fitPlane(sample.pts, sample.n, PLANE_THRESHOLD_MUL * spacingOf(manifest.bounds, manifest.pointCount))
      if (!plane) { patch({ message: 'Plane fit failed (degenerate selection).', split: { fitted: false, inlierRatio: null } }); return }
      const q = buffers.qpos.array as Uint32Array
      const sideA = (i: number) => {
        const w0 = q[i * 2], w1 = q[i * 2 + 1]
        return signedDistance(plane, (w0 & 0xffff) * dq[0], (w0 >>> 16) * dq[1], (w1 & 0xffff) * dq[2]) >= 0
      }
      run(all, () => ops.tagSplit(bytes, sideA))
      patch({ message: undefined, split: { fitted: true, inlierRatio: plane.inlierRatio } })
    },
    beginGpuEdit() { undo.push(0, N - 1); patch({ busy: true }) },
    endGpuEdit() { patch({ busy: false }); refresh() },
    undo() { if (busy()) return; const r = undo.undo(); if (r) { buffers.uploadFlagsRange(r.min, r.max); refresh() } },
    redo() { if (busy()) return; const r = undo.redo(); if (r) { buffers.uploadFlagsRange(r.min, r.max); refresh() } },
    refresh,
    dispose() { undo.clear() },
  }
}
