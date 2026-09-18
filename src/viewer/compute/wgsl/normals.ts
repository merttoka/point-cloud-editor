import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Thread per point: PCA over every neighbour within radius (27-cell traversal), single-pass centred
// covariance of d = p_j − p_i (the point itself contributes d = 0), smallest eigenvector via Jacobi,
// +Z orientation, oct-encode. Mirrors compute/cpu/normals.ts.
export const normalsKernel = wgslFn(/* wgsl */ `
  fn normalsKernel(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
                   sorted: ptr<storage, array<u32>, read_write>, normals: ptr<storage, array<u32>, read_write>,
                   i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let r2 = radius * radius;
    let c0 = vec3<i32>(floor(p / radius));
    var n = 1u;
    var s = vec3<f32>(0.0);
    var xx = 0.0; var xy = 0.0; var xz = 0.0; var yy = 0.0; var yz = 0.0; var zz = 0.0;
    for (var dz = -1; dz <= 1; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let c = c0 + vec3<i32>(dx, dy, dz);
          if (any(c < vec3<i32>(0))) { continue; }
          let key = pcvCellKey(c, mask);
          let start = atomicLoad(&cellStart[key]);
          let end = atomicLoad(&cellStart[key + 1u]);
          for (var t = start; t < end; t++) {
            let j = sorted[t];
            if (j == i) { continue; }
            let d = pcvDecodePos(qpos[j], dqScale) - p;
            if (dot(d, d) > r2) { continue; }
            n += 1u; s += d;
            xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
          }
        }
      }
    }
    var out = pcvOctEncode(vec3<f32>(0.0, 0.0, 1.0));
    if (n >= 4u) {
      let cnt = f32(n);
      let m = s / cnt;
      let e = pcvSmallestEigenvector(array<f32, 9>(
        xx / cnt - m.x * m.x, xy / cnt - m.x * m.y, xz / cnt - m.x * m.z,
        xy / cnt - m.x * m.y, yy / cnt - m.y * m.y, yz / cnt - m.y * m.z,
        xz / cnt - m.x * m.z, yz / cnt - m.y * m.z, zz / cnt - m.z * m.z));
      if (e.w > 0.0) {
        var nrm = e.xyz;
        if (nrm.z < 0.0) { nrm = -nrm; }
        out = pcvOctEncode(nrm);
      }
    }
    normals[i] = out;
    return out;
  }
`, [helpers])
