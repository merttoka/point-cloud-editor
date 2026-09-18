import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Thread per word (4 points): AO = 1 − (neighbours above the tangent plane) / (neighbours within radius);
// whole-word store. Mirrors compute/cpu/ao.ts.
export const aoKernel = wgslFn(/* wgsl */ `
  fn aoKernel(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
              sorted: ptr<storage, array<u32>, read_write>, normals: ptr<storage, array<u32>, read_write>,
              ao: ptr<storage, array<u32>, read_write>, w: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32, eps: f32) -> u32 {
    var out = 0u;
    let r2 = radius * radius;
    for (var k = 0u; k < 4u; k++) {
      let i = w * 4u + k;
      if (i >= count) { break; }
      let p = pcvDecodePos(qpos[i], dqScale);
      let nrm = pcvOctDecode(normals[i]);
      let c0 = vec3<i32>(floor(p / radius));
      var total = 0u; var above = 0u;
      for (var dz = -1; dz <= 1; dz++) {
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            let c = c0 + vec3<i32>(dx, dy, dz);
            if (any(c < vec3<i32>(0))) { continue; }
            let key = pcvCellKey(c, mask);
            let start = atomicLoad(&cellStart[key]);
            let end = atomicLoad(&cellStart[key + 1u]);
            for (var s = start; s < end; s++) {
              let j = sorted[s];
              if (j == i) { continue; }
              let d = pcvDecodePos(qpos[j], dqScale) - p;
              if (dot(d, d) > r2) { continue; }
              total = total + 1u;
              if (dot(d, nrm) > eps) { above = above + 1u; }
            }
          }
        }
      }
      let a = select(1.0, 1.0 - f32(above) / f32(total), total > 0u);
      out = out | (u32(round(a * 255.0)) << (k * 8u));
    }
    ao[w] = out;
    return out;
  }
`, [helpers])
