import { strToU8, zipSync } from 'fflate'
import type { Manifest } from '../loader/manifest'
import { dequantize, unpackWords, WORDS_PER_POINT } from '../format/quant'
import { FLAG_DELETED } from './flags'

type V3 = [number, number, number]

// Two passes: count survivors, then copy into a preallocated array (never array-push at 20M).
export function compactPoints(words: Uint32Array, flags: Uint8Array, n: number): { words: Uint32Array; count: number; qmin: V3; qmax: V3 } {
  let count = 0
  for (let i = 0; i < n; i++) if (!(flags[i] & FLAG_DELETED)) count++
  const out = new Uint32Array(count * WORDS_PER_POINT)
  const qmin: V3 = [65535, 65535, 65535], qmax: V3 = [0, 0, 0]
  let k = 0
  for (let i = 0; i < n; i++) {
    if (flags[i] & FLAG_DELETED) continue
    const w0 = words[i * 2], w1 = words[i * 2 + 1]
    out[k++] = w0; out[k++] = w1
    const [x, y, z] = unpackWords(w0, w1)
    if (x < qmin[0]) qmin[0] = x; if (x > qmax[0]) qmax[0] = x
    if (y < qmin[1]) qmin[1] = y; if (y > qmax[1]) qmax[1] = y
    if (z < qmin[2]) qmin[2] = z; if (z > qmax[2]) qmax[2] = z
  }
  if (count === 0) { qmin[0] = qmin[1] = qmin[2] = 0 }
  return { words: out, count, qmin, qmax }
}

export function exportManifest(src: Manifest, count: number, qmin: V3, qmax: V3): Manifest {
  const dq = (q: V3): V3 => [0, 1, 2].map((a) => dequantize(q[a], src.bounds.min[a], src.bounds.max[a])) as V3
  return {
    version: 1, name: `${src.name} (export)`, source: `${src.source ?? ''}#export`, license: src.license, crs: src.crs, units: 'm',
    bounds: src.bounds, pointCount: count, bytesPerPoint: 8, file: 'points.bin', classMap: src.classMap,
    chunks: [{ offset: 0, count, bounds: { min: dq(qmin), max: dq(qmax) } }],
  }
}

export function buildZip(words: Uint32Array, manifest: Manifest): Uint8Array {
  return zipSync({
    'points.bin': [new Uint8Array(words.buffer, words.byteOffset, words.byteLength), { level: 0 }],
    'manifest.json': strToU8(JSON.stringify(manifest, null, 1)),
  })
}
