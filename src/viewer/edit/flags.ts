export { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B } from '../render/PointBuffers'
import { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B } from '../render/PointBuffers'

export interface Range { min: number; max: number }   // inclusive point indices

export function unionRange(a: Range | null, b: Range | null): Range | null {
  if (!a) return b
  if (!b) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
}

export function countFlags(bytes: Uint8Array): { selected: number; hidden: number; deleted: number; split: number } {
  let selected = 0, hidden = 0, deleted = 0, split = 0
  for (let i = 0; i < bytes.length; i++) {
    const f = bytes[i]
    if (f === 0) continue
    if (f & FLAG_SELECTED) selected++
    if (f & FLAG_HIDDEN) hidden++
    if (f & FLAG_DELETED) deleted++
    if (f & (FLAG_SPLIT_A | FLAG_SPLIT_B)) split++
  }
  return { selected, hidden, deleted, split }
}

export function selectionRange(bytes: Uint8Array): Range | null {
  let min = -1, max = -1
  for (let i = 0; i < bytes.length; i++) if (bytes[i] & FLAG_SELECTED) { if (min < 0) min = i; max = i }
  return min < 0 ? null : { min, max }
}

// Word w as the vertex stage reads it: byte 4w+k at shift 8k (little-endian).
export function wordOf(bytes: Uint8Array, w: number): number {
  const b = (k: number) => bytes[w * 4 + k] ?? 0
  return (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0
}
