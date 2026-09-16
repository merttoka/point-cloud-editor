import { ChunkQueue } from './chunkQueue'
import { fetchAll, type LoaderIn, type LoaderOut } from './fetchChunks'

const ctx = self as unknown as { postMessage(msg: LoaderOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<LoaderIn>) => void) | null }
let queue: ChunkQueue | null = null
let ac: AbortController | null = null

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'camera') { queue?.setCamera(msg.pos); return }
  if (msg.type === 'dispose') { ac?.abort(); queue = null; return }
  queue = new ChunkQueue(msg.chunks)
  if (msg.pos) queue.setCamera(msg.pos)
  ac = new AbortController()
  fetchAll(msg.binUrl, queue, {
    fetch: (input, init) => fetch(input, init),
    post: (index, words) => ctx.postMessage({ type: 'chunk', index, words }, [words.buffer]),
    signal: ac.signal,
  })
    .then(() => ctx.postMessage({ type: 'done' }))
    .catch((err: unknown) => { if (!ac?.signal.aborted) ctx.postMessage({ type: 'error', message: String(err) }) })
}
