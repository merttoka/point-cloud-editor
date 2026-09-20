export { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B } from '../render/PointBuffers'
import { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B } from '../render/PointBuffers'

export interface Range { min: number; max: number }   // inclusive point indices

export function unionRange(a: Range | null, b: Range | null): Range | null {
  if (!a) return b
  if (!b) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
}

export interface FlagCounts { selected: number; hidden: number; deleted: number; split: number }

// One pass over the mirror (20 MB at 20M): per-bit counts plus the first..last selected index.
export function scanFlags(bytes: Uint8Array): { counts: FlagCounts; selRange: Range | null } {
  let selected = 0, hidden = 0, deleted = 0, split = 0, min = -1, max = -1
  for (let i = 0; i < bytes.length; i++) {
    const f = bytes[i]
    if (f === 0) continue
    if (f & FLAG_SELECTED) { selected++; if (min < 0) min = i; max = i }
    if (f & FLAG_HIDDEN) hidden++
    if (f & FLAG_DELETED) deleted++
    if (f & (FLAG_SPLIT_A | FLAG_SPLIT_B)) split++
  }
  return { counts: { selected, hidden, deleted, split }, selRange: min < 0 ? null : { min, max } }
}
