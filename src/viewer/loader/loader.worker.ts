import { ChunkQueue } from './chunkQueue'
import { fetchAll, type LoaderIn, type LoaderOut } from './fetchChunks'
import { BYTES_PER_POINT } from '../format/quant'
import { runCpu } from '../compute/cpu/run'

const ctx = self as unknown as { postMessage(msg: LoaderOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<LoaderIn>) => void) | null }
let queue: ChunkQueue | null = null
let ac: AbortController | null = null
let benchCancel = false

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'camera') { queue?.setCamera(msg.pos); return }
  if (msg.type === 'dispose') { ac?.abort(); queue = null; return }
  if (msg.type === 'cancelBench') { benchCancel = true; return }
  if (msg.type === 'cpuBench') {
    benchCancel = false
    runCpu(msg, {
      progress: (frac) => ctx.postMessage({ type: 'benchProgress', frac }),
      cancelled: () => benchCancel,
      yield: () => new Promise((r) => setTimeout(r, 0)),   // lets the cancel message land between slices
    }).then((res) => {
      if (!res) { ctx.postMessage({ type: 'benchCancelled' }); return }
      ctx.postMessage({ type: 'benchDone', normals: res.normals, ao: res.ao, ms: res.ms }, [res.normals.buffer, res.ao.buffer])
    }).catch(() => ctx.postMessage({ type: 'benchCancelled' }))   // worker exceptions surface as a cancelled bench
    return
  }
  queue = new ChunkQueue(msg.chunks)
  if (msg.pos) queue.setCamera(msg.pos)
  ac = new AbortController()
  const totalBytes = msg.chunks.reduce((max, c) => Math.max(max, (c.offset + c.count) * BYTES_PER_POINT), 0)
  fetchAll(msg.binUrl, queue, {
    fetch: (input, init) => fetch(input, init),
    post: (index, words) => ctx.postMessage({ type: 'chunk', index, words }, [words.buffer]),
    signal: ac.signal,
    totalBytes,
  })
    .then(() => ctx.postMessage({ type: 'done' }))
    .catch((err: unknown) => { if (!ac?.signal.aborted) ctx.postMessage({ type: 'error', message: String(err) }) })
}
