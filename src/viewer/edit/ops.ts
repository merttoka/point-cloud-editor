import { FLAG_HIDDEN, FLAG_SELECTED, FLAG_DELETED, FLAG_SPLIT_A, FLAG_SPLIT_B, type Range, unionRange } from './flags'
import type { SelectMode, SplitSide } from '../state/store'

const SEL_BITS = FLAG_SELECTED | FLAG_SPLIT_A | FLAG_SPLIT_B

export function sideMask(side: SplitSide): number { return side === 'A' ? FLAG_SPLIT_A : side === 'B' ? FLAG_SPLIT_B : 0 }
export function isSubject(f: number, side: SplitSide): boolean {
  return (f & FLAG_SELECTED) !== 0 && (side === 'all' || (f & sideMask(side)) !== 0)
}

// Generic pass: `next(f, i)` returns the new byte; the touched range spans the first..last changed index.
function pass(bytes: Uint8Array, from: number, to: number, next: (f: number, i: number) => number): Range | null {
  let min = -1, max = -1
  for (let i = from; i <= to; i++) {
    const f = bytes[i], g = next(f, i)
    if (g !== f) { bytes[i] = g; if (min < 0) min = i; max = i }
  }
  return min < 0 ? null : { min, max }
}
const whole = (b: Uint8Array, next: (f: number, i: number) => number) => pass(b, 0, b.length - 1, next)

export const isolate = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) || (f & FLAG_DELETED) ? f : f | FLAG_HIDDEN)
export const hide = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) ? (f & ~SEL_BITS) | FLAG_HIDDEN : f)
export const del = (b: Uint8Array, side: SplitSide) => whole(b, (f) => isSubject(f, side) ? (f & ~SEL_BITS) | FLAG_DELETED : f)
export const unhideAll = (b: Uint8Array) => whole(b, (f) => f & ~FLAG_HIDDEN)
export const clearSelection = (b: Uint8Array, range: Range | null) =>
  range ? pass(b, range.min, range.max, (f) => f & ~SEL_BITS) : whole(b, (f) => f & ~SEL_BITS)

export function applyPick(b: Uint8Array, idx: number, mode: SelectMode, selRange: Range | null): Range | null {
  if (mode === 'subtract') return pass(b, idx, idx, (f) => f & ~SEL_BITS)
  const cleared = mode === 'replace' ? clearSelection(b, selRange) : null
  const set = pass(b, idx, idx, (f) => f | FLAG_SELECTED)
  return unionRange(cleared, set)
}

export const tagSplit = (b: Uint8Array, sideA: (i: number) => boolean) =>
  whole(b, (f, i) => (f & FLAG_SELECTED) ? (f & ~(FLAG_SPLIT_A | FLAG_SPLIT_B)) | (sideA(i) ? FLAG_SPLIT_A : FLAG_SPLIT_B) : f)
