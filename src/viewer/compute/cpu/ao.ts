import { forEachNeighbour, type Grid } from './hash'
import { octDecode } from './normals'

const SLICE = 100_000

// Fraction of neighbours within radius that lie above the tangent plane (dot(pj − p, n) > eps) → occlusion.
export function aoAt(g: Grid, pos: Float32Array, i: number, n: [number, number, number], eps: number): number {
  let total = 0, above = 0
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  forEachNeighbour(g, pos, i, g.radius * g.radius, (j) => {
    total++
    if ((pos[j * 3] - px) * n[0] + (pos[j * 3 + 1] - py) * n[1] + (pos[j * 3 + 2] - pz) * n[2] > eps) above++
  })
  return total === 0 ? 1 : 1 - above / total
}

// Fills out[start, end) so a caller can slice the work.
export function computeAo(g: Grid, pos: Float32Array, normals: Uint32Array, end: number, eps: number, out = new Uint8Array(end), start = 0, onSlice?: (done: number) => void): Uint8Array {
  for (let i = start; i < end; i++) {
    out[i] = Math.round(aoAt(g, pos, i, octDecode(normals[i]), eps) * 255)
    if (onSlice && ((i + 1) % SLICE === 0 || i + 1 === end)) onSlice(i + 1)
  }
  return out
}
