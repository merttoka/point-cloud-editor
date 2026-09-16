import { StorageBufferAttribute } from 'three/webgpu'
import type { StorageBufferNode } from 'three/webgpu'
import { storage } from 'three/tsl'
import { WORDS_PER_POINT } from '../format/quant'

export const FLAG_HIDDEN = 1
export const FLAG_SELECTED = 2
export const FLAG_DELETED = 4
export const FLAG_SPLIT_A = 8
export const FLAG_SPLIT_B = 16

export interface PointBuffers {
  count: number
  qpos: StorageBufferAttribute
  flags: StorageBufferAttribute
  qposNode: StorageBufferNode<'uvec2'>
  flagsNode: StorageBufferNode<'uint'>
  loaded: Uint8Array           // 1 per chunk once uploaded
  uploadRange(offset: number, words: Uint32Array): void
  dispose(): void
}

export function createPointBuffers(count: number, chunkCount: number): PointBuffers {
  const flagWords = Math.ceil(count / 4)   // one flag byte per point
  const qpos = new StorageBufferAttribute(new Uint32Array(count * WORDS_PER_POINT), WORDS_PER_POINT)
  const flags = new StorageBufferAttribute(new Uint32Array(flagWords), 1)
  // Same node bound read_write in compute (later phases) and read in vertex; never toReadOnly().
  const qposNode = storage(qpos, 'uvec2', count)
  const flagsNode = storage(flags, 'uint', flagWords)
  return {
    count, qpos, flags, qposNode, flagsNode,
    loaded: new Uint8Array(chunkCount),
    uploadRange(offset, words) {
      ;(qpos.array as Uint32Array).set(words, offset * WORDS_PER_POINT)
      qpos.addUpdateRange(offset * WORDS_PER_POINT, words.length)
      qpos.needsUpdate = true
    },
    dispose() {
      // Known limitation: Node.dispose() only emits an event, and r3f 9.7 never calls gl.dispose() on a
      // WebGPURenderer at <Canvas> unmount (it only tries renderLists/forceContextLoss, which don't exist on it),
      // so these GPU buffers and the renderer live until the page unloads.
      qposNode.dispose()
      flagsNode.dispose()
    },
  }
}
