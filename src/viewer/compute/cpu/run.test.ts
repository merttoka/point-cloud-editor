import { describe, it, expect } from 'vitest'
import { runCpu } from './run'
import { packWords } from '../../format/quant'

function words(n: number): Uint32Array {
  const w = new Uint32Array(n * 2)
  let s = 5; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  for (let i = 0; i < n; i++) { const [a, b] = packWords(Math.floor(r() * 65535), Math.floor(r() * 65535), Math.floor(r() * 2000), 0); w[i * 2] = a; w[i * 2 + 1] = b }
  return w
}

describe('runCpu', () => {
  it('produces normals + ao for every point, reports progress up to 1, times each stage', async () => {
    const n = 5000, progress: number[] = []
    const res = await runCpu({ words: words(n), n, dqScale: [0.01, 0.01, 0.01], radius: 3, tableSize: 1024 },
      { progress: (f) => progress.push(f), cancelled: () => false, yield: () => Promise.resolve() })
    expect(res).not.toBeNull()
    expect(res!.normals.length).toBe(n); expect(res!.ao.length).toBe(n)
    expect(progress[progress.length - 1]).toBe(1)
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true)
    expect(progress.length).toBe(1 + 1 + 1)      // hash + one normals slice + one ao slice at n = 5000
    expect(res!.ms.hash).toBeGreaterThanOrEqual(0); expect(res!.ms.normals).toBeGreaterThan(0); expect(res!.ms.ao).toBeGreaterThanOrEqual(0)
  })
  it('reports one progress step per 100k slice', async () => {
    const n = 250_000, progress: number[] = []
    await runCpu({ words: words(n), n, dqScale: [0.001, 0.001, 0.001], radius: 0.5, tableSize: 32768 },
      { progress: (f) => progress.push(f), cancelled: () => false, yield: () => Promise.resolve() })
    expect(progress.length).toBe(1 + 3 + 3)      // hash, 3 normals slices, 3 ao slices
  })
  it('returns null when cancelled', async () => {
    let calls = 0
    const res = await runCpu({ words: words(300_000), n: 300_000, dqScale: [0.001, 0.001, 0.001], radius: 1, tableSize: 65536 },
      { progress: () => {}, cancelled: () => ++calls > 1, yield: () => Promise.resolve() })
    expect(res).toBeNull()
  })
})
