import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Every kernel returns a u32 and the call is .toVar()-ed (three 0.186 drops void wgslFn calls).
// cellStart / cellCursor are array<atomic<u32>> everywhere (storage(...).toAtomic()); non-atomic use goes
// through atomicLoad / atomicStore.

export const zeroCells = wgslFn(/* wgsl */ `
  fn zeroCells(cellStart: ptr<storage, array<atomic<u32>>, read_write>, i: u32, n: u32) -> u32 {
    if (i < n) { atomicStore(&cellStart[i], 0u); }
    return 0u;
  }
`)

export const countCells = wgslFn(/* wgsl */ `
  fn countCells(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
                i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let key = pcvCellKey(vec3<i32>(floor(p / radius)), mask);
    atomicAdd(&cellStart[key], 1u);
    return key;
  }
`, [helpers])

// Reduce-then-scan over T cells in blocks of 256, thread-per-block, serial inside the block (no workgroup memory).
export const reduceBlocks = wgslFn(/* wgsl */ `
  fn reduceBlocks(cellStart: ptr<storage, array<atomic<u32>>, read_write>, blockSums: ptr<storage, array<u32>, read_write>,
                  b: u32, blocks: u32) -> u32 {
    if (b >= blocks) { return 0u; }
    var sum = 0u;
    for (var j = 0u; j < 256u; j++) { sum = sum + atomicLoad(&cellStart[b * 256u + j]); }
    blockSums[b] = sum;
    return sum;
  }
`)

export const scanBlockSums = wgslFn(/* wgsl */ `
  fn scanBlockSums(blockSums: ptr<storage, array<u32>, read_write>, i: u32, blocks: u32) -> u32 {
    if (i != 0u) { return 0u; }
    var acc = 0u;
    for (var b = 0u; b < blocks; b++) { let v = blockSums[b]; blockSums[b] = acc; acc = acc + v; }
    return acc;
  }
`)

export const scanCells = wgslFn(/* wgsl */ `
  fn scanCells(cellStart: ptr<storage, array<atomic<u32>>, read_write>, cellCursor: ptr<storage, array<atomic<u32>>, read_write>,
               blockSums: ptr<storage, array<u32>, read_write>, b: u32, blocks: u32, tableSize: u32) -> u32 {
    if (b >= blocks) { return 0u; }
    var acc = blockSums[b];
    for (var j = 0u; j < 256u; j++) {
      let c = b * 256u + j;
      let v = atomicLoad(&cellStart[c]);
      atomicStore(&cellStart[c], acc);
      atomicStore(&cellCursor[c], acc);
      acc = acc + v;
    }
    if (b == blocks - 1u) { atomicStore(&cellStart[tableSize], acc); }
    return acc;
  }
`)

export const scatterPoints = wgslFn(/* wgsl */ `
  fn scatterPoints(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellCursor: ptr<storage, array<atomic<u32>>, read_write>,
                   sorted: ptr<storage, array<u32>, read_write>, i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let key = pcvCellKey(vec3<i32>(floor(p / radius)), mask);
    let slot = atomicAdd(&cellCursor[key], 1u);
    sorted[slot] = i;
    return slot;
  }
`, [helpers])
