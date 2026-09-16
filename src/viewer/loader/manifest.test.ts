import { describe, it, expect } from 'vitest'
import { validateManifest, resolveBinUrl, fetchManifest } from './manifest'

const good = {
  version: 1, name: 'demo', units: 'm', bytesPerPoint: 8, file: 'points.bin',
  bounds: { min: [0, 0, 0], max: [100, 100, 10] }, pointCount: 30,
  classMap: { '2': 'Ground' },
  chunks: [
    { offset: 0, count: 10, bounds: { min: [0, 0, 0], max: [50, 50, 10] } },
    { offset: 10, count: 20, bounds: { min: [50, 0, 0], max: [100, 100, 10] } },
  ],
}

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const m = validateManifest(good)
    expect(m.pointCount).toBe(30)
    expect(m.chunks.length).toBe(2)
  })
  it('rejects wrong version', () => {
    expect(() => validateManifest({ ...good, version: 2 })).toThrow(/version/)
  })
  it('rejects bytesPerPoint != 8', () => {
    expect(() => validateManifest({ ...good, bytesPerPoint: 12 })).toThrow(/bytesPerPoint/)
  })
  it('rejects non-contiguous chunks', () => {
    const bad = { ...good, chunks: [good.chunks[0], { ...good.chunks[1], offset: 11 }] }
    expect(() => validateManifest(bad)).toThrow(/contiguous/)
  })
  it('rejects chunk sum != pointCount', () => {
    expect(() => validateManifest({ ...good, pointCount: 31 })).toThrow(/pointCount/)
  })
  it('rejects non-object', () => {
    expect(() => validateManifest(null)).toThrow()
  })
})

describe('resolveBinUrl', () => {
  it('resolves relative to the manifest url', () => {
    expect(resolveBinUrl('https://x.test/data/demo/manifest.json', 'points.bin'))
      .toBe('https://x.test/data/demo/points.bin')
    expect(resolveBinUrl('http://localhost:5173/data/demo/manifest.json', 'points.bin'))
      .toBe('http://localhost:5173/data/demo/points.bin')
  })
})

describe('fetchManifest', () => {
  it('fetches, validates, resolves bin url', async () => {
    const fetchFn = (async () => new Response(JSON.stringify(good), { status: 200 })) as unknown as typeof fetch
    const r = await fetchManifest('https://x.test/d/manifest.json', fetchFn)
    expect(r.binUrl).toBe('https://x.test/d/points.bin')
    expect(r.manifest.name).toBe('demo')
  })
  it('throws on HTTP error', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(fetchManifest('https://x.test/d/manifest.json', fetchFn)).rejects.toThrow(/404/)
  })
})
