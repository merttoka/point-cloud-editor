import { describe, it, expect } from 'vitest'
import { ChunkQueue, type ChunkRef } from './chunkQueue'
import { rangeHeader, sliceChunk, fetchAll } from './fetchChunks'

const chunks: ChunkRef[] = [
  { index: 0, offset: 0, count: 3, centre: [0, 0, 0] },
  { index: 1, offset: 3, count: 2, centre: [1, 0, 0] },
]
// 5 points × 2 words; word value = point index * 10 + word
const full = new Uint32Array(10).map((_, i) => Math.floor(i / 2) * 10 + (i % 2))

describe('rangeHeader / sliceChunk', () => {
  it('range covers offset*8 .. (offset+count)*8-1', () => {
    expect(rangeHeader(chunks[1])).toBe('bytes=24-39')
  })
  it('slice returns the chunk words as a fresh buffer', () => {
    const w = sliceChunk(full.buffer, chunks[1])
    expect(Array.from(w)).toEqual([30, 31, 40, 41])
    expect(w.buffer).not.toBe(full.buffer)
  })
})

function rangeFetch(log: string[], url = 'https://cdn.test/points.bin'): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')!
    log.push(`${String(input)} ${range}`)
    const [a, b] = range.replace('bytes=', '').split('-').map(Number)
    const body = full.buffer.slice(a, b + 1)
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/40` } })
  }) as unknown as typeof fetch
}

describe('fetchAll', () => {
  it('Range path: posts each chunk with the right words, nearest first', async () => {
    const log: string[] = []
    const posted: [number, number[]][] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([1, 0, 0])
    await fetchAll('https://x.test/points.bin', q, {
      fetch: rangeFetch(log), post: (i, w) => posted.push([i, Array.from(w)]), signal: new AbortController().signal, concurrency: 1,
    })
    expect(posted).toEqual([[1, [30, 31, 40, 41]], [0, [0, 1, 10, 11, 20, 21]]])
    expect(log[0]).toBe('https://x.test/points.bin bytes=24-39')
    expect(log.length).toBe(chunks.length)   // one request per chunk, nothing extra
  })
  it('Range path with concurrency 4 still issues exactly one request per chunk', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    await fetchAll('https://x.test/points.bin', q, { fetch: rangeFetch(log), post: () => {}, signal: new AbortController().signal, concurrency: 4 })
    expect(log.length).toBe(chunks.length)
  })
  it('reuses response.url for subsequent chunks after the first response', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    // Response.url is read-only; emulate a redirect by returning a Response whose url getter reports the CDN
    const f = rangeFetch(log)
    const withUrl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await f(input, init)
      Object.defineProperty(r, 'url', { value: 'https://cdn.test/signed/points.bin' })
      return r
    }) as unknown as typeof fetch
    await fetchAll('https://x.test/points.bin', q, { fetch: withUrl, post: () => {}, signal: new AbortController().signal, concurrency: 1 })
    expect(log[0].startsWith('https://x.test/')).toBe(true)
    expect(log[1].startsWith('https://cdn.test/signed/')).toBe(true)
  })
  it('falls back to binUrl once when the reused url fails', async () => {
    const log: string[] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    const f = rangeFetch(log)
    let calls = 0
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      if (calls === 1) { const r = await f(input, init); Object.defineProperty(r, 'url', { value: 'https://cdn.test/expired' }); return r }
      if (String(input).includes('expired')) { log.push(`${String(input)} 403`); return new Response('', { status: 403 }) }
      return f(input, init)
    }) as unknown as typeof fetch
    const posted: number[] = []
    await fetchAll('https://x.test/points.bin', q, { fetch: flaky, post: (i) => posted.push(i), signal: new AbortController().signal, concurrency: 1 })
    expect(posted.sort()).toEqual([0, 1])
    expect(log.some((l) => l.endsWith('403'))).toBe(true)
    expect(log[log.length - 1].startsWith('https://x.test/')).toBe(true)
  })
  it('full-fetch fallback: 200 without Content-Range → exactly one fetch even at concurrency 4, all chunks sliced locally', async () => {
    let fetches = 0
    const fullFetch = (async () => { fetches++; return new Response(full.buffer.slice(0), { status: 200 }) }) as unknown as typeof fetch
    const posted: [number, number[]][] = []
    const q = new ChunkQueue(chunks)
    q.setCamera([0, 0, 0])
    await fetchAll('https://x.test/points.bin', q, { fetch: fullFetch, post: (i, w) => posted.push([i, Array.from(w)]), signal: new AbortController().signal, concurrency: 4 })
    expect(fetches).toBe(1)
    expect(posted.sort((a, b) => a[0] - b[0])).toEqual([[0, [0, 1, 10, 11, 20, 21]], [1, [30, 31, 40, 41]]])
  })
  it('stops on abort', async () => {
    const ac = new AbortController()
    ac.abort()
    const q = new ChunkQueue(chunks)
    const posted: number[] = []
    await fetchAll('https://x.test/points.bin', q, { fetch: rangeFetch([]), post: (i) => posted.push(i), signal: ac.signal })
    expect(posted).toEqual([])
  })
})
