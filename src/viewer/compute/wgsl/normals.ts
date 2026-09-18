import { wgslFn } from 'three/tsl'
import { helpers } from './helpers'

// Thread per point: 27-cell kNN (K = 16, register insertion sort), PCA over the point + neighbours,
// smallest eigenvector via Jacobi, +Z orientation, oct-encode. Mirrors compute/cpu/normals.ts.
export const normalsKernel = wgslFn(/* wgsl */ `
  fn normalsKernel(qpos: ptr<storage, array<vec2<u32>>, read_write>, cellStart: ptr<storage, array<atomic<u32>>, read_write>,
                   sorted: ptr<storage, array<u32>, read_write>, normals: ptr<storage, array<u32>, read_write>,
                   i: u32, count: u32, dqScale: vec3<f32>, radius: f32, mask: u32) -> u32 {
    if (i >= count) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale);
    let r2 = radius * radius;
    let c0 = vec3<i32>(floor(p / radius));
    var nd: array<f32, 16>;
    var ni: array<u32, 16>;
    var n = 0u;
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
            let d2 = dot(d, d);
            if (d2 > r2) { continue; }
            if (n < 16u) {
              var m = n;
              while (m > 0u && nd[m - 1u] > d2) { nd[m] = nd[m - 1u]; ni[m] = ni[m - 1u]; m = m - 1u; }
              nd[m] = d2; ni[m] = j; n = n + 1u;
            } else if (d2 < nd[15]) {
              var m = 15u;
              while (m > 0u && nd[m - 1u] > d2) { nd[m] = nd[m - 1u]; ni[m] = ni[m - 1u]; m = m - 1u; }
              nd[m] = d2; ni[m] = j;
            }
          }
        }
      }
    }
    var out = pcvOctEncode(vec3<f32>(0.0, 0.0, 1.0));
    if (n >= 3u) {
      var mean = p;
      for (var m = 0u; m < n; m++) { mean = mean + pcvDecodePos(qpos[ni[m]], dqScale); }
      let cnt = f32(n + 1u);
      mean = mean / cnt;
      var xx = 0.0; var xy = 0.0; var xz = 0.0; var yy = 0.0; var yz = 0.0; var zz = 0.0;
      var d = p - mean;
      xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
      for (var m = 0u; m < n; m++) {
        d = pcvDecodePos(qpos[ni[m]], dqScale) - mean;
        xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
      }
      let e = pcvSmallestEigenvector(array<f32, 9>(xx / cnt, xy / cnt, xz / cnt, xy / cnt, yy / cnt, yz / cnt, xz / cnt, yz / cnt, zz / cnt));
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
