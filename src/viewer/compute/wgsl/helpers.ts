import { wgsl } from 'three/tsl'

// Shared WGSL helpers, included by the kernels that decode positions or normals (`wgslFn(src, [helpers])`). Mirrors compute/cpu/*.
export const helpers = wgsl(/* wgsl */ `
fn pcvDecodePos(w: vec2<u32>, dqScale: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(f32(w.x & 0xffffu), f32(w.x >> 16u), f32(w.y & 0xffffu)) * dqScale;
}
fn pcvCellKey(c: vec3<i32>, mask: u32) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) & mask;
}
fn pcvOctEncode(n: vec3<f32>) -> u32 {
  let l1 = abs(n.x) + abs(n.y) + abs(n.z);
  var p = n.xy / l1;
  if (n.z < 0.0) {
    p = (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
  }
  let u = vec2<u32>(round((p * 0.5 + 0.5) * 65535.0));
  return u.x | (u.y << 16u);
}
fn pcvOctDecode(w: u32) -> vec3<f32> {
  let f = vec2<f32>(f32(w & 0xffffu), f32(w >> 16u)) / 65535.0 * 2.0 - 1.0;
  var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  if (n.z < 0.0) {
    let t = (vec2<f32>(1.0) - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0));
    n = vec3<f32>(t, n.z);
  }
  return normalize(n);
}
// Cyclic Jacobi on a symmetric 3x3 (row-major array), 8 sweeps. xyz = eigenvector of the smallest eigenvalue,
// w = 0 when the two smallest eigenvalues coincide (within 1e-6) — the caller substitutes +Z.
fn pcvSmallestEigenvector(mIn: array<f32, 9>) -> vec4<f32> {
  var a = mIn;
  var v = array<f32, 9>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  for (var sweep = 0; sweep < 8; sweep++) {
    for (var p = 0; p < 2; p++) {
      for (var q = p + 1; q < 3; q++) {
        let apq = a[p * 3 + q];
        if (abs(apq) < 1e-12) { continue; }
        let theta = (a[q * 3 + q] - a[p * 3 + p]) / (2.0 * apq);
        let sg = select(-1.0, 1.0, theta >= 0.0);
        let t = sg / (abs(theta) + sqrt(theta * theta + 1.0));
        let c = 1.0 / sqrt(t * t + 1.0);
        let s = t * c;
        a[p * 3 + p] = a[p * 3 + p] - t * apq;
        a[q * 3 + q] = a[q * 3 + q] + t * apq;
        a[p * 3 + q] = 0.0; a[q * 3 + p] = 0.0;
        let r = 3 - p - q;
        let arp = a[r * 3 + p]; let arq = a[r * 3 + q];
        a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p];
        a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q];
        for (var k = 0; k < 3; k++) {
          let vkp = v[k * 3 + p]; let vkq = v[k * 3 + q];
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let l0 = a[0]; let l1 = a[4]; let l2 = a[8];
  var k = 0; var lmin = l0; var lmid = min(l1, l2);
  if (l1 < lmin) { k = 1; lmid = min(l0, l2); lmin = l1; }
  if (l2 < lmin) { k = 2; lmid = min(l0, l1); lmin = l2; }
  if (lmid - lmin < 1e-6) { return vec4<f32>(0.0, 0.0, 1.0, 0.0); }
  let e = vec3<f32>(v[k], v[3 + k], v[6 + k]);
  let len = length(e);
  if (!(len > 0.0)) { return vec4<f32>(0.0, 0.0, 1.0, 0.0); }
  return vec4<f32>(e / len, 1.0);
}
`)
