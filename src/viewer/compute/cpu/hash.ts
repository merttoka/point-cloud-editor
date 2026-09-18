// CPU mirror of wgsl/hash.ts: same key, same cell = floor(p / radius) in bounds-relative metres, same
// 27-cell radius traversal. Reference for the GPU readback in Verify and the algorithm the benchmark times.

export interface Grid { cellStart: Uint32Array; sorted: Uint32Array; radius: number; mask: number }

export function decodePositions(words: Uint32Array, n: number, dqScale: [number, number, number]): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const w0 = words[i * 2], w1 = words[i * 2 + 1]
    out[i * 3] = (w0 & 0xffff) * dqScale[0]
    out[i * 3 + 1] = (w0 >>> 16) * dqScale[1]
    out[i * 3 + 2] = (w1 & 0xffff) * dqScale[2]
  }
  return out
}

export function cellKey(cx: number, cy: number, cz: number, mask: number): number {
  const h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0
  return (h & mask) >>> 0
}

export function exclusiveScan(counts: Uint32Array): Uint32Array {
  const out = new Uint32Array(counts.length + 1)
  let acc = 0
  for (let i = 0; i < counts.length; i++) { out[i] = acc; acc += counts[i] }
  out[counts.length] = acc
  return out
}

function keyOf(pos: Float32Array, i: number, radius: number, mask: number): number {
  return cellKey(Math.floor(pos[i * 3] / radius), Math.floor(pos[i * 3 + 1] / radius), Math.floor(pos[i * 3 + 2] / radius), mask)
}

export function buildGrid(pos: Float32Array, n: number, radius: number, T: number): Grid {
  const mask = T - 1
  const counts = new Uint32Array(T)
  for (let i = 0; i < n; i++) counts[keyOf(pos, i, radius, mask)]++
  const cellStart = exclusiveScan(counts)
  const cursor = cellStart.slice(0, T)
  const sorted = new Uint32Array(n)
  for (let i = 0; i < n; i++) sorted[cursor[keyOf(pos, i, radius, mask)]++] = i
  return { cellStart, sorted, radius, mask }
}

export function forEachNeighbour(g: Grid, pos: Float32Array, i: number, r2: number, visit: (j: number, d2: number) => void): void {
  const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
  const cx = Math.floor(px / g.radius), cy = Math.floor(py / g.radius), cz = Math.floor(pz / g.radius)
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = cx + dx, y = cy + dy, z = cz + dz
    if (x < 0 || y < 0 || z < 0) continue
    const key = cellKey(x, y, z, g.mask)
    for (let s = g.cellStart[key], end = g.cellStart[key + 1]; s < end; s++) {
      const j = g.sorted[s]
      if (j === i) continue
      const ex = pos[j * 3] - px, ey = pos[j * 3 + 1] - py, ez = pos[j * 3 + 2] - pz
      const d2 = ex * ex + ey * ey + ez * ez
      if (d2 <= r2) visit(j, d2)
    }
  }
}
