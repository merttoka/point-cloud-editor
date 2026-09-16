import * as THREE from 'three/webgpu'
import { Fn, instanceIndex, storage, uint, wgslFn } from 'three/tsl'
import type { Node, StorageBufferNode } from 'three/webgpu'

// One thread per u32 word (4 packed u8 flags). Thread-per-word: whole-word stores, no atomics.
// Sets bit0 of a point's flag byte when quantized x > 32767 (east half).
//
// Returns the word instead of `-> void`: in three 0.186 FunctionCallNode.generate never emits its
// own statement line and StackNode.build ignores the void build result, so a void wgslFn call
// compiles to an empty kernel body. Consuming the u32 result with .toVar() forces `var = classifyEast(...)` into the flow.
// Storage pointer params work: three passes `&NodeBuffer_N.value` (WGSLNodeBuilder.getPropertyName).
const classifyEast = wgslFn(/* wgsl */ `
  fn classifyEast(
    qpos: ptr<storage, array<vec2<u32>>, read_write>,
    flags: ptr<storage, array<u32>, read_write>,
    word: u32,
    count: u32
  ) -> u32 {
    var out: u32 = 0u;
    for (var k: u32 = 0u; k < 4u; k = k + 1u) {
      let i = word * 4u + k;
      if (i >= count) { break; }
      let x = qpos[i].x & 0xffffu;
      if (x > 32767u) { out = out | (1u << (k * 8u)); }
    }
    flags[word] = out;
    return out;
  }
`)

export function buildFlagsCompute(qpos: StorageBufferNode<'uvec2'>, count: number) {
  const words = Math.ceil(count / 4)
  const flagsAttr = new THREE.StorageBufferAttribute(new Uint32Array(words), 1)
  const flags = storage(flagsAttr, 'uint', words)
  const computeNode = Fn(() => {
    // Cast: @types/three types a wgslFn call as untyped Node, which lacks .toVar().
    ;(classifyEast({ qpos, flags, word: instanceIndex, count: uint(count) }) as Node<'uint'>).toVar()
  })().compute(words)
  return { flagsAttr, flags, computeNode, words }
}
