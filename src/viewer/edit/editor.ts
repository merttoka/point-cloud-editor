import type { PointBuffers } from '../render/PointBuffers'
import type { Manifest } from '../loader/manifest'
import { patchEdit, type SelectMode, type Store, type ViewerState } from '../state/store'
import { dequantScale } from '../format/quant'
import { spacingOf } from '../compute/params'
import { scanFlags, unionRange, FLAG_SELECTED, type Range } from './flags'
import { createUndoRing } from './undo'
import * as ops from './ops'
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
  }
  // Whole-buffer ops: push N bytes first, drop the command again if nothing changed.
  const run = (pushRange: Range, op: () => Range | null) => {
    if (!ready()) return
    undo.push(pushRange.min, pushRange.max)
    const r = op()
    if (!r) { undo.dropLast(); return }
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
    let n = 0
    for (let i = 0; i < N; i++) if (bytes[i] & FLAG_SELECTED) n++
    const pts = new Float32Array(n * 3)
    for (let i = 0, k = 0; i < N; i++) if (bytes[i] & FLAG_SELECTED) { decodeScaled(i, pts, k); k += 3 }
    return { pts, n }
  }

  return {
    bytes,
    ready,
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
    dispose() { undo.clear() },
  }
}
