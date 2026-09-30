import { StorageBufferAttribute } from 'three/webgpu'
import type { StorageBufferNode } from 'three/webgpu'
import { storage } from 'three/tsl'

// Layer visibility, read by the vertex stage and the select kernels: word 0 = class mask (bit min(cls, 31)),
// words 1..8 = segment mask (bit per segment id, 256 bits; bit 0 = unsegmented points). Bit set = visible.
export const MASK_WORDS = 9
export const SEG_MAX = 255

export const classBit = (cls: number) => Math.min(cls, 31)
export function getBit(words: Uint32Array, word: number, bit: number): boolean { return ((words[word] >>> bit) & 1) === 1 }
export function setBit(words: Uint32Array, word: number, bit: number, on: boolean): void {
  words[word] = (on ? words[word] | (1 << bit) : words[word] & ~(1 << bit)) >>> 0
}
const segWord = (id: number) => 1 + (id >> 5)
export const isClassVisible = (words: Uint32Array, cls: number) => getBit(words, 0, classBit(cls))
export const isSegmentVisible = (words: Uint32Array, id: number) => getBit(words, segWord(id), id & 31)
export const setClassVisible = (words: Uint32Array, cls: number, on: boolean) => setBit(words, 0, classBit(cls), on)
export const setSegmentVisible = (words: Uint32Array, id: number, on: boolean) => setBit(words, segWord(id), id & 31, on)
export const isVisible = (words: Uint32Array, cls: number, segId: number) => isClassVisible(words, cls) && isSegmentVisible(words, segId)
export const allVisible = (words: Uint32Array) => words.every((w) => w === 0xffffffff)
export function fillVisible(words: Uint32Array): void { words.fill(0xffffffff) }

export interface LayerMasks {
  attr: StorageBufferAttribute
  node: StorageBufferNode<'uint'>
  words: Uint32Array          // = attr.array; mutate with setClassVisible / setSegmentVisible, then upload()
  upload(): void              // whole buffer (36 B)
}

export function createLayerMasks(): LayerMasks {
  const attr = new StorageBufferAttribute(new Uint32Array(MASK_WORDS).fill(0xffffffff), 1)
  const node = storage(attr, 'uint', MASK_WORDS)
  return {
    attr, node, words: attr.array as Uint32Array,
    upload() { attr.addUpdateRange(0, MASK_WORDS); attr.needsUpdate = true },
  }
}
