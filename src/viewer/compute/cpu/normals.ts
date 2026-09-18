import { K } from '../params'
import { knn, type Grid } from './hash'

// CPU mirror of normals.wgsl.ts. Matrices are number[9] row-major; symmetric input.

const EIG_EPS = 1e-6
const SLICE = 100_000

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
  return ux | (uy << 16)
}

// Decode divides by 65536 (not the encode-side 65535) so the round-half-up quantization centre
// (32768, 32768) — the code +Z always encodes to — inverts to exactly (0, 0); the sub-ULP scale
// difference elsewhere is far inside the round-trip tolerance.
export function octDecode(w: number): [number, number, number] {
  const fx = ((w & 0xffff) / 65536) * 2 - 1, fy = ((w >>> 16) / 65536) * 2 - 1
  let x = fx, y = fy
  const z = 1 - Math.abs(fx) - Math.abs(fy)
  if (z < 0) { x = (1 - Math.abs(fy)) * (fx >= 0 ? 1 : -1); y = (1 - Math.abs(fx)) * (fy >= 0 ? 1 : -1) }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

export function normalAt(g: Grid, pos: Float32Array, i: number): [number, number, number] {
  const nn = knn(g, pos, i, K)
  if (nn.n < 3) return [0, 0, 1]
  // mean over the point and its neighbours
  let mx = pos[i * 3], my = pos[i * 3 + 1], mz = pos[i * 3 + 2]
  for (let m = 0; m < nn.n; m++) { const j = nn.idx[m]; mx += pos[j * 3]; my += pos[j * 3 + 1]; mz += pos[j * 3 + 2] }
  const cnt = nn.n + 1
  mx /= cnt; my /= cnt; mz /= cnt
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  const acc = (j: number) => {
    const dx = pos[j * 3] - mx, dy = pos[j * 3 + 1] - my, dz = pos[j * 3 + 2] - mz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  acc(i)
  for (let m = 0; m < nn.n; m++) acc(nn.idx[m])
  const v = smallestEigenvector([xx / cnt, xy / cnt, xz / cnt, xy / cnt, yy / cnt, yz / cnt, xz / cnt, yz / cnt, zz / cnt])
  if (!v) return [0, 0, 1]
  return v[2] < 0 ? [-v[0], -v[1], -v[2]] : v
}

// Fills out[start, end) so a caller can slice the work (the worker yields between slices).
export function computeNormals(g: Grid, pos: Float32Array, end: number, out = new Uint32Array(end), start = 0, onSlice?: (done: number) => void): Uint32Array {
  for (let i = start; i < end; i++) {
    out[i] = octEncode(normalAt(g, pos, i))
    if (onSlice && ((i + 1) % SLICE === 0 || i + 1 === end)) onSlice(i + 1)
  }
  return out
}
