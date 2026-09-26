import { describe, it, expect } from 'vitest'
import { createPointBuffers } from '../render/PointBuffers'
import { createStore, initialState } from '../state/store'
import { createEditor } from './editor'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { packWords } from '../format/quant'
import { SEGMENT_PALETTE } from './layers'
import type { Manifest } from '../loader/manifest'

// 100 m cube; 8 points on a slightly noisy plane z ≈ 50 (world): x spread 0..85, y 0..40, z = 49 or 51 alternating.
// y must not be linear in x (a stride of 3000 makes y = 0.375 x → PCA's smallest axis is the in-plane perpendicular, not z).
const manifest: Manifest = {
  version: 1, name: 't', units: 'm', bounds: { min: [0, 0, 0], max: [100, 100, 100] }, pointCount: 8, bytesPerPoint: 8,
  file: 'points.bin', classMap: {}, chunks: [{ offset: 0, count: 8, bounds: { min: [0, 0, 0], max: [100, 100, 100] } }],
}
function setup() {
  const buffers = createPointBuffers(8, 1)
  const q = buffers.qpos.array as Uint32Array
  for (let i = 0; i < 8; i++) { const [a, b] = packWords(i * 8000, (i * 13000) % 30000, i % 2 ? 33422 : 32112, 0); q[i * 2] = a; q[i * 2 + 1] = b }
  const store = createStore(initialState)
  store.set({ status: 'ready' })                     // the editor refuses edits while chunks are still arriving
  return { buffers, store, editor: createEditor(buffers, manifest, store) }
}
describe('editor', () => {
  it('pick replace/add, hide, undo/redo upload ranges and refresh counts', () => {
    const { buffers, store, editor } = setup()
    editor.pick(2, 'replace'); editor.pick(5, 'add')
    expect(store.get().edit.counts.selected).toBe(2)
    expect(buffers.flags.updateRanges.at(-1)).toEqual({ start: 1, count: 1 })
    editor.hide()
    expect(Array.from(editor.bytes)).toEqual([0, 0, H, 0, 0, H, 0, 0])
    expect(store.get().edit.counts).toEqual({ selected: 0, hidden: 2, deleted: 0, split: 0 })
    expect(store.get().edit.undoDepth).toBe(3)
    editor.undo()
    expect(Array.from(editor.bytes)).toEqual([0, 0, S, 0, 0, S, 0, 0])
    expect(store.get().edit.redoDepth).toBe(1)
    editor.redo()
    expect(editor.bytes[2]).toBe(H)
  })
  it('pick miss in replace mode clears; no-op ops leave the undo depth alone', () => {
    const { store, editor } = setup()
    editor.pick(1, 'replace'); editor.pick(null, 'replace')
    expect(store.get().edit.counts.selected).toBe(0)
    expect(store.get().edit.undoDepth).toBe(2)
    editor.del()                       // nothing selected
    expect(store.get().edit.undoDepth).toBe(2)
  })
  it('split tags sides by the fitted plane and side filter drives delete', () => {
    const { store, editor } = setup()
    for (let i = 0; i < 8; i++) editor.pick(i, 'add')
    editor.split()                     // threshold 2 × spacing = 70 m → all inliers; PCA normal ≈ z through the centroid (z = 50): 4 above, 4 below
    const bytes = Array.from(editor.bytes)
    const a = bytes.filter((f) => f & A).length, b = bytes.filter((f) => f & B).length
    expect(a).toBe(4); expect(b).toBe(4)
    expect(store.get().edit.split.fitted).toBe(true)
    store.set({ edit: { ...store.get().edit, splitSide: 'A' } })
    editor.del()
    expect(store.get().edit.counts.deleted).toBe(a)
    expect(store.get().edit.counts.selected).toBe(b)
  })
  it('stale split side resets once the tags are gone; ops on a fresh selection work again', () => {
    const { store, editor } = setup()
    for (let i = 0; i < 8; i++) editor.pick(i, 'add')
    editor.split()
    store.set({ edit: { ...store.get().edit, splitSide: 'A' } })
    editor.undo()
    expect(store.get().edit.split.fitted).toBe(false)
    expect(store.get().edit.splitSide).toBe('all')
    editor.pick(1, 'replace'); editor.hide()
    expect(store.get().edit.counts.hidden).toBe(1)
  })
  it('split with < 3 selected sets a message and no tags', () => {
    const { store, editor } = setup()
    editor.pick(0, 'add'); editor.split()
    expect(store.get().edit.message).toMatch(/3/)
    expect(store.get().edit.split.fitted).toBe(false)
  })
  it('ops are ignored while busy; endGpuEdit recounts', () => {
    const { store, editor } = setup()
    editor.beginGpuEdit()
    expect(store.get().edit.busy).toBe(true)
    editor.pick(0, 'add')
    expect(store.get().edit.counts.selected).toBe(0)
    editor.bytes[3] = S                // "readback" landed
    editor.endGpuEdit()
    expect(store.get().edit).toMatchObject({ busy: false, counts: { selected: 1, hidden: 0, deleted: 0 }, undoDepth: 1 })
    editor.undo()
    expect(editor.bytes[3]).toBe(0)
    editor.beginGpuEdit(); editor.abortGpuEdit()
    expect(store.get().edit).toMatchObject({ busy: false, undoDepth: 0 })
  })
})

// Same geometry, classes 2,2,2,2,6,6,6,7 in the packed byte.
function setupClassed() {
  const buffers = createPointBuffers(8, 1)
  const q = buffers.qpos.array as Uint32Array
  const cls = [2, 2, 2, 2, 6, 6, 6, 7]
  for (let i = 0; i < 8; i++) { const [a, b] = packWords(i * 8000, (i * 13000) % 30000, i % 2 ? 33422 : 32112, cls[i] << 8); q[i * 2] = a; q[i * 2 + 1] = b }
  const store = createStore(initialState)
  store.set({ status: 'ready' })
  return { buffers, store, editor: createEditor(buffers, manifest, store) }
}
describe('editor layers', () => {
  it('selectLayer goes through the undo ring like a lasso', () => {
    const { store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace')
    expect(store.get().edit.counts.selected).toBe(3)
    expect(store.get().edit.undoDepth).toBe(1)
    editor.selectLayer({ class: 7 }, 'add')
    expect(store.get().edit.counts.selected).toBe(4)
    editor.undo()
    expect(store.get().edit.counts.selected).toBe(3)
    editor.undo()
    expect(store.get().edit.counts.selected).toBe(0)
    expect(store.get().edit.redoDepth).toBe(2)
  })
  it('a masked layer is not selectable and its selected points are not op subjects', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 2 }, 'replace')
    editor.setLayerVisible({ class: 2 }, false)
    expect(buffers.masks.words[0]).toBe((0xffffffff & ~(1 << 2)) >>> 0)
    expect(buffers.masks.attr.version).toBe(1)
    expect(store.get().layers.classVisible[2]).toBe(false)
    editor.hide()                                   // subjects are selected ∧ visible → none
    expect(store.get().edit.counts.hidden).toBe(0)
    expect(store.get().edit.undoDepth).toBe(1)      // no-op left no entry
    editor.selectLayer({ class: 2 }, 'add')         // no visible members → no-op, no entry
    expect(store.get().edit.undoDepth).toBe(1)
    editor.setLayerVisible({ class: 2 }, true)
    editor.hide()
    expect(store.get().edit.counts.hidden).toBe(4)
  })
  it('saveSegment claims the selection outside the undo ring; del reduces its count; undo restores it', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace')
    const s = editor.saveSegment()
    expect(s).toEqual({ id: 1, name: 'Segment 1', color: SEGMENT_PALETTE[0], count: 3, visible: true })
    expect(Array.from(editor.segBytes.subarray(0, 8))).toEqual([0, 0, 0, 0, 1, 1, 1, 0])
    expect(buffers.segIds.updateRanges.at(-1)).toEqual({ start: 1, count: 1 })
    expect(store.get().layers.segments).toEqual([s])
    expect(store.get().edit.undoDepth).toBe(1)      // still just the selectLayer
    editor.pick(4, 'replace'); editor.del()
    expect(store.get().layers.segments[0].count).toBe(2)
    editor.undo()
    expect(store.get().layers.segments[0].count).toBe(3)
    const s2 = editor.saveSegment()                  // undo restored point 4's SELECTED bit, so it moves to a new segment
    expect(s2?.id).toBe(2); expect(s2?.count).toBe(1)
    expect(store.get().layers.segments[0].count).toBe(2)
  })
  it('saveSegment with nothing selected returns null; custom name; exclusive membership moves points', () => {
    const { store, editor } = setupClassed()
    expect(editor.saveSegment()).toBeNull()
    editor.selectLayer({ class: 2 }, 'replace')
    expect(editor.saveSegment('roof')?.name).toBe('roof')
    editor.pick(0, 'replace'); editor.pick(4, 'add')
    const s2 = editor.saveSegment()
    expect(s2?.id).toBe(2); expect(s2?.count).toBe(2)
    expect(store.get().layers.segments.map((s) => s.count)).toEqual([3, 2])   // byte 0 moved from 1 to 2
  })
  it('deleteSegment returns its points to unsegmented and a reused id starts visible', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace'); editor.saveSegment()
    editor.setLayerVisible({ segment: 1 }, false)
    expect(store.get().layers.segments[0].visible).toBe(false)
    expect(buffers.masks.words[1]).toBe((0xffffffff & ~(1 << 1)) >>> 0)
    editor.deleteSegment(1)
    expect(store.get().layers.segments).toEqual([])
    expect(Array.from(editor.segBytes.subarray(0, 8)).every((v) => v === 0)).toBe(true)
    expect(buffers.masks.words[1]).toBe(0xffffffff)
    editor.selectLayer({ class: 7 }, 'replace')
    const s = editor.saveSegment()
    expect(s?.id).toBe(1); expect(s?.visible).toBe(true); expect(s?.count).toBe(1)
  })
  it('deleting a soloed segment returns its points to a visible unsegmented layer', () => {
    const { buffers, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace'); editor.saveSegment()
    editor.soloLayer({ segment: 1 })
    expect(buffers.masks.words[1]).toBe(1 << 1)
    editor.deleteSegment(1)
    expect(buffers.masks.words[1] & 0b11).toBe(0b11)   // unsegmented (bit 0) and the freed id both visible
  })
  it('rename and recolour patch the row; solo and show-all rewrite the masks', () => {
    const { buffers, store, editor } = setupClassed()
    editor.selectLayer({ class: 6 }, 'replace'); editor.saveSegment()
    editor.renameSegment(1, 'north wall'); editor.setSegmentColor(1, '#123456')
    expect(store.get().layers.segments[0]).toMatchObject({ name: 'north wall', color: '#123456' })
    editor.soloLayer({ segment: 1 })
    expect(buffers.masks.words[0]).toBe(0xffffffff)
    expect(buffers.masks.words[1]).toBe(1 << 1)
    expect(buffers.masks.words[8]).toBe(0)
    editor.soloLayer({ class: 6 })
    expect(buffers.masks.words[0]).toBe(1 << 6)
    expect(buffers.masks.words[1]).toBe(0xffffffff)
    expect(store.get().layers.classVisible).toEqual({ 6: true })   // solo writes every listed class; none are listed before ready (Task 6)
    editor.showAllLayers()
    expect(Array.from(buffers.masks.words).every((w) => w === 0xffffffff)).toBe(true)
    expect(store.get().layers.segments[0].visible).toBe(true)
  })
})
