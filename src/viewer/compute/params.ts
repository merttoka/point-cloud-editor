import type { Bounds } from '../format/quant'
import { WORDS_PER_POINT } from '../format/quant'

export const EPS_MUL = 0.02               // AO tangent-plane threshold = EPS_MUL × radius
export const BENCH_CAP = 2_000_000        // CPU benchmark / Verify point cap
export const SCAN_BLOCK = 256             // cells per scan block (serial per thread); templated into the scan kernels

export function spacingOf(b: Bounds, pointCount: number): number {
  return Math.sqrt(((b.max[0] - b.min[0]) * (b.max[1] - b.min[1])) / pointCount)
}

// Hash table size (A4): nextPow2(max(1024, N/8)). Collisions merge cells; the distance test filters.
export function tableSizeFor(pointCount: number): number {
  let t = 1024
  while (t < pointCount / 8) t *= 2
  return t
}

// Bench subset on sets larger than the cap: the first floor(n / chunks) points of every chunk, packed contiguously.
export function benchWords(words: Uint32Array, chunks: { offset: number; count: number }[], n: number): Uint32Array {
  const total = words.length / WORDS_PER_POINT
  if (n >= total) return words
  const per = Math.floor(n / chunks.length)
  const out = new Uint32Array(per * chunks.length * WORDS_PER_POINT)
  let written = 0
  for (const c of chunks) {
    const take = Math.min(per, c.count) * WORDS_PER_POINT
    out.set(words.subarray(c.offset * WORDS_PER_POINT, c.offset * WORDS_PER_POINT + take), written)
    written += take
  }
  return written === out.length ? out : out.slice(0, written)
}
