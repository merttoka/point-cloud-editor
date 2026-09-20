import { wgsl, wgslFn } from 'three/tsl'
import { helpers } from './helpers'
import { MAX_LASSO_VERTS } from '../../edit/lasso'

// Shared prologue for the pick/lasso family: world = q * dqScale + dqMinCentred (the material's frame), clip = viewProj * world,
// screen px from the CSS viewport. Mirrors edit/project.ts (projectPoint / pointInPolygon) exactly.
export const selectHelpers = wgsl(/* wgsl */ `
fn pcvProject(p: vec3<f32>, viewProj: mat4x4<f32>, viewport: vec2<f32>) -> vec4<f32> {
  let c = viewProj * vec4<f32>(p, 1.0);
  let ndc = c.xy / c.w;
  return vec4<f32>((ndc.x * 0.5 + 0.5) * viewport.x, (0.5 - ndc.y * 0.5) * viewport.y, c.z / c.w, c.w);
}
// chunkTable[c] = (offset, visibleEnd); the point's chunk is the last entry with offset <= i.
fn pcvVisibleEnd(chunkTable: ptr<storage, array<vec2<u32>>, read_write>, chunks: u32, i: u32) -> u32 {
  var lo = 0u; var hi = chunks;
  while (hi - lo > 1u) { let mid = (lo + hi) / 2u; if (chunkTable[mid].x <= i) { lo = mid; } else { hi = mid; } }
  return chunkTable[lo].y;
}
fn pcvInPoly(px: vec2<f32>, poly: ptr<storage, array<vec2<f32>>, read_write>, count: u32) -> bool {
  var inside = false;
  var j = count - 1u;
  for (var i = 0u; i < count; i++) {
    let a = poly[i]; let b = poly[j];
    if ((a.y > px.y) != (b.y > px.y) && px.x < (b.x - a.x) * (px.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
    j = i;
  }
  return inside;
}
`)

export const resetPick = wgslFn(/* wgsl */ `
  fn resetPick(pick: ptr<storage, array<atomic<u32>>, read_write>, i: u32) -> u32 {
    if (i < 2u) { atomicStore(&pick[i], 0xffffffffu); }
    return 0u;
  }
`)

// Pass 1: min depth bits among visible points within r px of the cursor. Depth in [0,1] is a non-negative f32, so
// bitcast<u32> orders like the value. r = max(3, attenuated size px) — the same size the material renders.
export const pickDepth = wgslFn(/* wgsl */ `
  fn pickDepth(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
               chunkTable: ptr<storage, array<vec2<u32>>, read_write>, pick: ptr<storage, array<atomic<u32>>, read_write>,
               i: u32, count: u32, chunks: u32, dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, view: mat4x4<f32>,
               viewport: vec2<f32>, cursor: vec2<f32>, pointSize: f32, refDist: f32) -> u32 {
    if (i >= count) { return 0u; }
    if (i >= pcvVisibleEnd(chunkTable, chunks, i)) { return 0u; }
    let f = (flags[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
    if ((f & 5u) != 0u) { return 0u; }                       // hidden | deleted
    let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
    let s = pcvProject(p, viewProj, viewport);
    if (s.w <= 0.0 || s.z < 0.0 || s.z > 1.0) { return 0u; }
    let viewZ = (view * vec4<f32>(p, 1.0)).z;
    let r = max(3.0, clamp(pointSize * refDist / -viewZ, 1.0, 8.0));
    let d = s.xy - cursor;
    if (dot(d, d) > r * r) { return 0u; }
    atomicMin(&pick[0], bitcast<u32>(s.z));
    return 1u;
  }
`, [helpers, selectHelpers])

// Pass 2: lowest index at exactly that depth (same expression → bit-identical).
export const pickIndex = wgslFn(/* wgsl */ `
  fn pickIndex(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
               chunkTable: ptr<storage, array<vec2<u32>>, read_write>, pick: ptr<storage, array<atomic<u32>>, read_write>,
               i: u32, count: u32, chunks: u32, dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, view: mat4x4<f32>,
               viewport: vec2<f32>, cursor: vec2<f32>, pointSize: f32, refDist: f32) -> u32 {
    if (i >= count) { return 0u; }
    if (i >= pcvVisibleEnd(chunkTable, chunks, i)) { return 0u; }
    let f = (flags[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
    if ((f & 5u) != 0u) { return 0u; }
    let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
    let s = pcvProject(p, viewProj, viewport);
    if (s.w <= 0.0 || s.z < 0.0 || s.z > 1.0) { return 0u; }
    let viewZ = (view * vec4<f32>(p, 1.0)).z;
    let r = max(3.0, clamp(pointSize * refDist / -viewZ, 1.0, 8.0));
    let d = s.xy - cursor;
    if (dot(d, d) > r * r) { return 0u; }
    if (bitcast<u32>(s.z) == atomicLoad(&pick[0])) { atomicMin(&pick[1], i); }
    return 1u;
  }
`, [helpers, selectHelpers])

// Thread per word: read once, test 4 points, write the word back. mode 0 replace (clear selected everywhere,
// set inside), 1 add (OR inside), 2 subtract (AND-NOT inside). bbox = (minX, minY, maxX, maxY) screen px.
export const lassoSelect = wgslFn(/* wgsl */ `
  fn lassoSelect(qpos: ptr<storage, array<vec2<u32>>, read_write>, flags: ptr<storage, array<u32>, read_write>,
                 chunkTable: ptr<storage, array<vec2<u32>>, read_write>, poly: ptr<storage, array<vec2<f32>>, read_write>,
                 w: u32, count: u32, chunks: u32, vertexCount: u32, mode: u32, bbox: vec4<f32>,
                 dqScale: vec3<f32>, dqMin: vec3<f32>, viewProj: mat4x4<f32>, viewport: vec2<f32>) -> u32 {
    if (w * 4u >= count) { return 0u; }
    var word = flags[w];
    for (var k = 0u; k < 4u; k++) {
      let i = w * 4u + k;
      if (i >= count) { break; }
      let shift = k * 8u;
      let f = (word >> shift) & 0xffu;
      var g = f;
      if (mode == 0u) { g = g & ~26u; }                      // replace: drop selected + split tags everywhere
      if ((f & 5u) == 0u && i < pcvVisibleEnd(chunkTable, chunks, i)) {
        let p = pcvDecodePos(qpos[i], dqScale) + dqMin;
        let s = pcvProject(p, viewProj, viewport);
        if (s.w > 0.0 && s.z >= 0.0 && s.z <= 1.0 && s.x >= bbox.x && s.x <= bbox.z && s.y >= bbox.y && s.y <= bbox.w
            && pcvInPoly(s.xy, poly, vertexCount)) {
          if (mode == 2u) { g = g & ~2u; } else { g = g | 2u; }
        }
      }
      if (mode == 2u && (g & 2u) == 0u) { g = g & ~24u; }       // dropped from the selection → drop split tags too
      word = (word & ~(0xffu << shift)) | (g << shift);
    }
    flags[w] = word;
    return word;
  }
`, [helpers, selectHelpers])

export const LASSO_POLY_WORDS = MAX_LASSO_VERTS * 2
