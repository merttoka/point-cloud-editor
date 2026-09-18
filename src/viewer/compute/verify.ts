import type { VerifyResult } from '../state/store'
import { octDecode, octEncode } from './cpu/normals'

const PLUS_Z = octEncode([0, 0, 1])

// Angular difference is sign-insensitive (the camera-facing flip happens at render time).
export function compareResults(gpuNormals: Uint32Array, gpuAo: Uint32Array, cpuNormals: Uint32Array, cpuAo: Uint8Array, n: number): VerifyResult {
  const angles = new Float32Array(n)
  let nonFinite = 0, degenerate = 0, aoErr = 0
  for (let i = 0; i < n; i++) {
    const a = octDecode(gpuNormals[i]), b = octDecode(cpuNormals[i])
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
    if (!Number.isFinite(d)) { nonFinite++; angles[i] = 180; continue }
    angles[i] = Math.acos(Math.min(1, d)) * 180 / Math.PI
    if (gpuNormals[i] === PLUS_Z) degenerate++
    const g = (gpuAo[i >> 2] >>> ((i & 3) * 8)) & 0xff
    aoErr += Math.abs(g - cpuAo[i]) / 255
  }
  const sorted = Float32Array.from(angles).sort()
  const medianDeg = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  return { n, medianDeg, maxDeg: n ? sorted[n - 1] : 0, aoMae: n ? aoErr / n : 0, nonFinite, degenerate }
}
