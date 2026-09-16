import { StorageBufferAttribute } from 'three/webgpu'
import type { StorageBufferNode } from 'three/webgpu'
import { storage } from 'three/tsl'

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
  const qpos = new StorageBufferAttribute(new Uint32Array(count * 2), 2)
  const flags = new StorageBufferAttribute(new Uint32Array(Math.ceil(count / 4)), 1)
  // Same node bound read_write in compute (later phases) and read in vertex; never toReadOnly().
  const qposNode = storage(qpos, 'uvec2', count)
  const flagsNode = storage(flags, 'uint', Math.ceil(count / 4))
  return {
    count, qpos, flags, qposNode, flagsNode,
    loaded: new Uint8Array(chunkCount),
    uploadRange(offset, words) {
      ;(qpos.array as Uint32Array).set(words, offset * 2)
      qpos.addUpdateRange(offset * 2, words.length)
      qpos.needsUpdate = true
    },
    dispose() {
      // Node.dispose() only dispatches a 'dispose' event. r3f 9.7's unmountComponentAtNode does
      // NOT call gl.dispose() on a WebGPURenderer (it only calls renderLists?.dispose /
      // forceContextLoss?.(), which don't exist on it) — so <Canvas> unmount never disposes the
      // renderer, and these GPU buffers (N×8 + ceil(N/4)×4 B) plus the renderer itself live until
      // the page unloads. Known limitation; revisit when the viewer supports remount/dataset switching.
      qposNode.dispose()
      flagsNode.dispose()
    },
  }
}
