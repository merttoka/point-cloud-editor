import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { compactPoints, exportManifest, buildZip } from './export'
import { packWords, unpackWords } from '../format/quant'
import { validateManifest, type Manifest } from '../loader/manifest'
import { FLAG_DELETED, FLAG_HIDDEN } from './flags'

const src: Manifest = {
  version: 1, name: 'demo', source: 'tile', units: 'm', bounds: { min: [0, 0, 0], max: [10, 20, 30] }, pointCount: 4, bytesPerPoint: 8,
  file: 'points.bin', classMap: { '2': 'Ground' }, chunks: [{ offset: 0, count: 4, bounds: { min: [0, 0, 0], max: [10, 20, 30] } }],
}
function words() {
  const w = new Uint32Array(8)
  const q = [[0, 0, 0, 1], [100, 200, 300, 2], [65535, 65535, 65535, 3], [5, 6, 7, 4]]
  q.forEach(([x, y, z, a], i) => { const [w0, w1] = packWords(x, y, z, a); w[i * 2] = w0; w[i * 2 + 1] = w1 })
  return w
}
describe('export', () => {
  it('compactPoints drops exactly the deleted points, keeps order and hidden ones, tracks q bounds', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, FLAG_HIDDEN, 0])
    const r = compactPoints(words(), flags, 4)
    expect(r.count).toBe(3)
    expect(r.words.length).toBe(6)
    expect(unpackWords(r.words[0], r.words[1])).toEqual([0, 0, 0, 1])
    expect(unpackWords(r.words[2], r.words[3])).toEqual([65535, 65535, 65535, 3])
    expect(unpackWords(r.words[4], r.words[5])).toEqual([5, 6, 7, 4])
    expect(r.qmin).toEqual([0, 0, 0]); expect(r.qmax).toEqual([65535, 65535, 65535])
  })
  it('exportManifest: one chunk, same quantization bounds, chunk bounds dequantized', () => {
    const m = exportManifest(src, 2, [100, 200, 300], [65535, 65535, 65535])
    expect(m.chunks).toHaveLength(1)
    expect(m.bounds).toEqual(src.bounds)
    expect(m.pointCount).toBe(2)
    expect(m.chunks[0].bounds.min[0]).toBeCloseTo(100 / 65535 * 10)
    expect(m.chunks[0].bounds.max).toEqual([10, 20, 30])
    expect(m.source).toBe('tile#export'); expect(m.name).toBe('demo (export)')
    expect(() => validateManifest(JSON.parse(JSON.stringify(m)))).not.toThrow()
  })
  it('all-deleted export: zero points, empty bin, manifest still validates', () => {
    const flags = new Uint8Array([FLAG_DELETED, FLAG_DELETED, FLAG_DELETED, FLAG_DELETED])
    const r = compactPoints(words(), flags, 4)
    expect(r.count).toBe(0)
    expect(r.words.length).toBe(0)
    expect(r.qmin).toEqual([0, 0, 0]); expect(r.qmax).toEqual([0, 0, 0])
    const m = exportManifest(src, r.count, r.qmin, r.qmax)
    expect(m.pointCount).toBe(0)
    expect(m.chunks[0].bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] })
    expect(() => validateManifest(JSON.parse(JSON.stringify(m)))).not.toThrow()
    const files = unzipSync(buildZip(r.words, m))
    expect(files['points.bin'].byteLength).toBe(0)
  })
  it('zip round-trips through unzipSync', () => {
    const flags = new Uint8Array([0, FLAG_DELETED, 0, 0])
    const r = compactPoints(words(), flags, 4)
    const m = exportManifest(src, r.count, r.qmin, r.qmax)
    const files = unzipSync(buildZip(r.words, m))
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'points.bin'])
    expect(files['points.bin'].byteLength).toBe(3 * 8)
    expect(new Uint32Array(files['points.bin'].slice().buffer)).toEqual(r.words)   // slice: unzip views may be unaligned for Uint32Array
    expect(JSON.parse(strFromU8(files['manifest.json'])).pointCount).toBe(3)
  })
})
