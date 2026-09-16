import type { ChunkQueue, ChunkRef } from './chunkQueue'

export type LoaderIn =
  | { type: 'start'; binUrl: string; chunks: ChunkRef[] }
  | { type: 'camera'; pos: [number, number, number] }
  | { type: 'dispose' }
export type LoaderOut =
  | { type: 'chunk'; index: number; words: Uint32Array }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface LoaderIO {
  fetch: typeof fetch
  post(index: number, words: Uint32Array): void
  signal: AbortSignal
  concurrency?: number
}

export function rangeHeader(c: ChunkRef): string {
  return `bytes=${c.offset * 8}-${(c.offset + c.count) * 8 - 1}`
}

export function sliceChunk(full: ArrayBuffer, c: ChunkRef): Uint32Array {
  return new Uint32Array(full.slice(c.offset * 8, (c.offset + c.count) * 8))
}

export async function fetchAll(binUrl: string, queue: ChunkQueue, io: LoaderIO): Promise<void> {
  if (io.signal.aborted) return
  const first = queue.pop()
  if (!first) return
  let url = binUrl           // switches to response.url after the first response (skips the 302 per chunk)

  const fetchOne = (c: ChunkRef, target: string): Promise<Response> =>
    io.fetch(target, { headers: { Range: rangeHeader(c) }, signal: io.signal })

  const fetchChunk = async (c: ChunkRef): Promise<Response> => {
    let res = await fetchOne(c, url)
    if (!res.ok && url !== binUrl) {          // reused CDN url expired → retry from the origin once
      url = binUrl
      res = await fetchOne(c, url)
    }
    if (!res.ok) throw new Error(`chunk ${c.index}: HTTP ${res.status}`)
    return res
  }

  const postRange = async (c: ChunkRef, res: Response): Promise<void> => {
    const buf = await res.arrayBuffer()
    if (buf.byteLength !== c.count * 8) throw new Error(`chunk ${c.index}: expected ${c.count * 8} bytes, got ${buf.byteLength}`)
    io.post(c.index, new Uint32Array(buf))
  }

  // Discovery is serialised: the first chunk alone decides the mode (Range vs full file) and
  // yields the post-redirect URL. Only then does the pool start, so the full-fetch fallback
  // never downloads the file more than once.
  const res = await fetchChunk(first)
  if (res.status === 200 && !res.headers.get('Content-Range')) {
    const full = await res.arrayBuffer()
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
      await postRange(c, await fetchChunk(c))
    }
  })
  await Promise.all(workers)
}
