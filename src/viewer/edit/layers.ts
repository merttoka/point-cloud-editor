import { FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B, type Range } from './flags'
import { isSubject, type Vis } from './ops'
import type { SegmentMeta } from '../loader/manifest'
import type { Segment, SelectMode, SplitSide } from '../state/store'
import { SEG_MAX } from '../render/layerMasks'

export { ALL, type Vis } from './ops'

// Pure byte ops for layers: the segId mirror (`seg`, one byte per point, 0 = none) and the flags mirror.
export type Layer = { class: number } | { segment: number }

export const SEGMENT_PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff']
const SEL_BITS = FLAG_SELECTED | FLAG_SPLIT_A | FLAG_SPLIT_B

export const classOf = (q: Uint32Array, i: number) => q[i * 2 + 1] >>> 24

export function classCounts(q: Uint32Array, n: number): Record<number, number> {
  const counts = new Uint32Array(256)
  for (let i = 0; i < n; i++) counts[q[i * 2 + 1] >>> 24]++
  const out: Record<number, number> = {}
  for (let c = 0; c < 256; c++) if (counts[c] > 0) out[c] = counts[c]
  return out
}

// Live count per id: points carrying it that are not deleted (hidden ones count).
export function countSegments(seg: Uint8Array, flags: Uint8Array, n: number): Uint32Array {
  const counts = new Uint32Array(256)
  for (let i = 0; i < n; i++) { const s = seg[i]; if (s !== 0 && !(flags[i] & FLAG_DELETED)) counts[s]++ }
  return counts
}

export function freeSegmentId(used: Iterable<number>): number | null {
  const taken = new Set(used)
  for (let id = 1; id <= SEG_MAX; id++) if (!taken.has(id)) return id
  return null
}

// Every subject point (selected ∧ side ∧ vis) takes `id`, leaving whatever segment it had (exclusive membership).
export function claimSegment(seg: Uint8Array, flags: Uint8Array, n: number, id: number, side: SplitSide, vis: Vis): { range: Range | null; count: number } {
  let min = -1, max = -1, count = 0
  for (let i = 0; i < n; i++) {
    if (!isSubject(flags[i], side) || !vis(i)) continue
    seg[i] = id; count++
    if (min < 0) min = i
    max = i
  }
  return { range: min < 0 ? null : { min, max }, count }
}

export function releaseSegment(seg: Uint8Array, n: number, id: number): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < n; i++) if (seg[i] === id) { seg[i] = 0; if (min < 0) min = i; max = i }
  return min < 0 ? null : { min, max }
}

export function layerMember(layer: Layer, q: Uint32Array, seg: Uint8Array): (i: number) => boolean {
  return 'class' in layer ? (i) => classOf(q, i) === layer.class : (i) => seg[i] === layer.segment
}

// Like a lasso over the layer: replace clears every selection bit first; add ORs; subtract clears (split tags go with it).
// Only visible members (`vis`: not hidden/deleted and layer-visible) are touched.
export function selectLayer(flags: Uint8Array, n: number, member: (i: number) => boolean, mode: SelectMode, vis: Vis): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < n; i++) {
    const f = flags[i]
    let g = mode === 'replace' ? f & ~SEL_BITS : f
    if (vis(i) && member(i)) g = mode === 'subtract' ? g & ~SEL_BITS : g | FLAG_SELECTED
    if (g !== f) { flags[i] = g; if (min < 0) min = i; max = i }
  }
  return min < 0 ? null : { min, max }
}

// Import: copy `src` (one byte per point, from segments.bin) into the mirror, dropping ids the table doesn't list.
export function applySegmentBytes(dst: Uint8Array, src: Uint8Array, table: SegmentMeta[]): { segments: Segment[]; unknown: number } {
  const known = new Uint8Array(256)
  for (const s of table) known[s.id] = 1
  const counts = new Uint32Array(256)
  let unknown = 0
  for (let i = 0; i < src.length; i++) {
    const s = src[i]
    if (s !== 0 && !known[s]) { unknown++; dst[i] = 0; continue }
    dst[i] = s; counts[s]++
  }
  return { segments: table.map((s) => ({ id: s.id, name: s.name, color: s.color, count: counts[s.id], visible: true })), unknown }
}
