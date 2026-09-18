import { forEachNeighbour, type Grid } from './hash'

// CPU mirror of wgsl/normals.ts. Matrices are number[9] row-major; symmetric input.

const EIG_EPS = 1e-6

export function jacobiEigen(m: number[]): { values: [number, number, number]; vectors: number[] } {
  const a = m.slice()
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = a[p * 3 + q]
      if (Math.abs(apq) < 1e-12) continue
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const sg = theta >= 0 ? 1 : -1
      const t = sg / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      a[p * 3 + p] -= t * apq
      a[q * 3 + q] += t * apq
      a[p * 3 + q] = 0; a[q * 3 + p] = 0
      const r = 3 - p - q                                   // the third index
      const arp = a[r * 3 + p], arq = a[r * 3 + q]
      a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p]
      a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q]
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v }
}

export function smallestEigenvector(m: number[]): [number, number, number] | null {
  const { values, vectors } = jacobiEigen(m)
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
  if (values[order[1]] - values[order[0]] < EIG_EPS) return null
  const k = order[0]
  const x = vectors[k], y = vectors[3 + k], z = vectors[6 + k]
  const l = Math.hypot(x, y, z)
  if (!(l > 0) || !Number.isFinite(l)) return null
  return [x / l, y / l, z / l]
}

export function octEncode(n: [number, number, number]): number {
  const l1 = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])
  let px = n[0] / l1, py = n[1] / l1
  if (n[2] < 0) {
    const qx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1), qy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1)
    px = qx; py = qy
  }
  const ux = Math.round((px * 0.5 + 0.5) * 65535), uy = Math.round((py * 0.5 + 0.5) * 65535)
  return (ux | (uy << 16)) >>> 0
}

export function octDecode(w: number): [number, number, number] {
  const fx = ((w & 0xffff) / 65535) * 2 - 1, fy = ((w >>> 16) / 65535) * 2 - 1
  let x = fx, y = fy
  const z = 1 - Math.abs(fx) - Math.abs(fy)
  if (z < 0) { x = (1 - Math.abs(fy)) * (fx >= 0 ? 1 : -1); y = (1 - Math.abs(fx)) * (fy >= 0 ? 1 : -1) }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

export function normalAt(g: Grid, pos: Float32Array, i: number): [number, number, number] {
  // Single-pass covariance of d = p_j − p_i over every neighbour within radius (+ the point itself, d = 0):
  // centring on p_i keeps the sums small so the f32 kernel and this mirror agree.
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  let n = 1, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  forEachNeighbour(g, pos, i, g.radius * g.radius, (j) => {
    const dx = pos[j * 3] - px, dy = pos[j * 3 + 1] - py, dz = pos[j * 3 + 2] - pz
    n++; sx += dx; sy += dy; sz += dz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  })
  if (n < 4) return [0, 0, 1]
  const mx = sx / n, my = sy / n, mz = sz / n
  const v = smallestEigenvector([
    xx / n - mx * mx, xy / n - mx * my, xz / n - mx * mz,
    xy / n - mx * my, yy / n - my * my, yz / n - my * mz,
    xz / n - mx * mz, yz / n - my * mz, zz / n - mz * mz,
  ])
  if (!v) return [0, 0, 1]
  return v[2] < 0 ? [-v[0], -v[1], -v[2]] : v
}

// Fills out[start, end) so a caller can slice the work (the worker yields between slices).
export function computeNormals(g: Grid, pos: Float32Array, end: number, out = new Uint32Array(end), start = 0): Uint32Array {
  for (let i = start; i < end; i++) out[i] = octEncode(normalAt(g, pos, i))
  return out
}
