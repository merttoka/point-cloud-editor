import type { ChunkQueue, ChunkRef } from './chunkQueue'
import { BYTES_PER_POINT } from '../format/quant'

export type LoaderIn =
  | { type: 'start'; binUrl: string; chunks: ChunkRef[]; pos?: [number, number, number] }
  | { type: 'camera'; pos: [number, number, number] }
  | { type: 'dispose' }
  | { type: 'cpuBench'; words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }
  | { type: 'cancelBench' }
export type LoaderOut =
  | { type: 'chunk'; index: number; words: Uint32Array }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'benchProgress'; frac: number }
  | { type: 'benchDone'; normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }
  | { type: 'benchCancelled' }

export interface LoaderIO {
  fetch: typeof fetch
  post(index: number, words: Uint32Array): void
  signal: AbortSignal
  concurrency?: number
  totalBytes?: number
}

export function rangeHeader(c: ChunkRef): string {
  return `bytes=${c.offset * BYTES_PER_POINT}-${(c.offset + c.count) * BYTES_PER_POINT - 1}`
}

export function sliceChunk(full: ArrayBuffer, c: ChunkRef): Uint32Array {
  return new Uint32Array(full.slice(c.offset * BYTES_PER_POINT, (c.offset + c.count) * BYTES_PER_POINT))
}

export async function fetchAll(binUrl: string, queue: ChunkQueue, io: LoaderIO): Promise<void> {
  if (io.signal.aborted) return
  const first = queue.pop()
  if (!first) return
  let url = binUrl           // switches to response.url after the first response (skips the 302 per chunk)

  const fetchOne = (c: ChunkRef): Promise<Response> =>
    io.fetch(url, { headers: { Range: rangeHeader(c) }, signal: io.signal })

  const fetchChunk = async (c: ChunkRef): Promise<Response> => {
    let res = await fetchOne(c)
    if (!res.ok && url !== binUrl) {          // reused CDN url expired → retry from the origin once
      await res.body?.cancel()
      url = binUrl
      res = await fetchOne(c)
    }
    if (!res.ok) {
      await res.body?.cancel()   // release the connection before the caller retries
      throw new Error(`chunk ${c.index}: HTTP ${res.status}`)
    }
    return res
  }

  const retryOnce = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (e) { if (io.signal.aborted) throw e; return fn() }
  }

  const postRange = async (c: ChunkRef, res: Response): Promise<void> => {
    const buf = await res.arrayBuffer()
    const expected = c.count * BYTES_PER_POINT
    if (buf.byteLength !== expected) throw new Error(`chunk ${c.index}: expected ${expected} bytes, got ${buf.byteLength}`)
    io.post(c.index, new Uint32Array(buf))
  }

  // Discovery is serialised: the first chunk alone decides the mode (Range vs full file) and
  // yields the post-redirect URL. Only then does the pool start, so the full-fetch fallback
  // never downloads the file more than once.
  const res = await retryOnce(() => fetchChunk(first))
  if (res.status === 200 && !res.headers.get('Content-Range')) {
    const full = await res.arrayBuffer()
    if (io.totalBytes !== undefined && full.byteLength !== io.totalBytes) {
      throw new Error(`full fetch: expected ${io.totalBytes} bytes, got ${full.byteLength}`)
    }
    io.post(first.index, sliceChunk(full, first))
    for (let c = queue.pop(); c && !io.signal.aborted; c = queue.pop()) io.post(c.index, sliceChunk(full, c))
    return
  }
  if (res.url && res.url !== url) url = res.url
  await postRange(first, res)

  const workers = Array.from({ length: io.concurrency ?? 4 }, async () => {
    for (;;) {
      if (io.signal.aborted) return
      const c = queue.pop()
      if (!c) return
      await retryOnce(async () => postRange(c, await fetchChunk(c)))
    }
  })
  await Promise.all(workers)
}
