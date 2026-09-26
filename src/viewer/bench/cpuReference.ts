import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import type { ViewerApi } from '../render/Scene'
import { centroidOf } from '../loader/manifest'
import { dequantScale } from '../format/quant'
import { cpuLasso, cpuPick, decodeWorld, projectPoint } from '../edit/project'
import { packPoly, type Poly } from '../edit/lasso'
import { FLAG_DELETED, FLAG_HIDDEN } from '../edit/flags'

// CPU reference for the GPU select kernels: same matrices (api.viewParams from EditRunner), same visibility rule
// (not hidden/deleted, inside the chunk's budget prefix), same attenuated radius as pickDepth.
export function createCpuReference(buffers: PointBuffers, manifest: Manifest, api: ViewerApi) {
  const centroid = centroidOf(manifest.bounds)
  const dq = dequantScale(manifest.bounds), b = manifest.bounds
  const dqMin: [number, number, number] = [b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]]
  const q = buffers.qpos.array as Uint32Array
  const ref = () => {
    const v = api.viewParams!()
    const end = new Uint32Array(manifest.chunks.length)
    manifest.chunks.forEach((ch, k) => { end[k] = ch.offset + (buffers.loaded[k] ? Math.ceil(ch.count * v.budget) : 0) })
    const chunkOf = (i: number) => { let lo = 0, hi = manifest.chunks.length; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (manifest.chunks[m].offset <= i) lo = m; else hi = m }; return lo }
    const visible = (i: number) => (buffers.flagBytes[i] & (FLAG_HIDDEN | FLAG_DELETED)) === 0 && i < end[chunkOf(i)]
    const m = v.view.elements
    const radiusPx = (i: number) => {
      const [x, y, z] = decodeWorld(q, i, dq, dqMin)
      const viewZ = m[2] * x + m[6] * y + m[10] * z + m[14]
      return Math.max(3, Math.min(8, Math.max(1, v.pointSize * v.refDist / -viewZ)))
    }
    return { v, vp: v.viewProj.elements, visible, radiusPx }
  }
  return {
    cpuPick: (x: number, y: number) => { const r = ref(); return cpuPick(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, x, y, r.visible, r.radiusPx) },
    cpuLasso: (poly: Poly) => { const r = ref(); const { data, count } = packPoly(poly); return cpuLasso(q, buffers.count, dq, dqMin, r.vp, r.v.width, r.v.height, data, count, r.visible) },
    depthOf: (i: number) => { const r = ref(); const [x, y, z] = decodeWorld(q, i, dq, dqMin); return projectPoint(x, y, z, r.vp, r.v.width, r.v.height)?.[2] ?? null },
  }
}
