import { EPS_MUL } from '../params'
import { buildGrid, decodePositions } from './hash'
import { computeNormals } from './normals'
import { computeAo } from './ao'

export interface CpuInput { words: Uint32Array; n: number; dqScale: [number, number, number]; radius: number; tableSize: number }
export interface CpuIO { progress(frac: number): void; cancelled(): boolean; yield(): Promise<void> }
export interface CpuResult { normals: Uint32Array; ao: Uint8Array; ms: { hash: number; normals: number; ao: number } }

const SLICE = 100_000

// Same passes as the GPU pipeline, cooperative: yields to the event loop every SLICE points so the worker
// can see a cancel message between slices. Benchmark and oracle only — never a rendering path.
export async function runCpu(input: CpuInput, io: CpuIO): Promise<CpuResult | null> {
  const { n, radius } = input
  let t = performance.now()
  const pos = decodePositions(input.words, n, input.dqScale)
  const grid = buildGrid(pos, n, radius, input.tableSize)
  const hash = performance.now() - t
  io.progress(0.1)
  await io.yield()
  if (io.cancelled()) return null

  t = performance.now()
  const normals = new Uint32Array(n)
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE)
    computeNormals(grid, pos, end, normals, start)
    io.progress(0.1 + 0.6 * (end / n))
    await io.yield()
    if (io.cancelled()) return null
  }
  const normalsMs = performance.now() - t

  t = performance.now()
  const ao = new Uint8Array(n)
  const eps = EPS_MUL * radius
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE)
    computeAo(grid, pos, normals, end, eps, ao, start)
    io.progress(0.7 + 0.3 * (end / n))
    await io.yield()
    if (io.cancelled()) return null
  }
  return { normals, ao, ms: { hash, normals: normalsMs, ao: performance.now() - t } }
}
