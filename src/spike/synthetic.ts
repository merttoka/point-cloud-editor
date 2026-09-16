import { quantize, packAttr, packWords, type Bounds } from '../viewer/format/quant'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SyntheticCloud {
  words: Uint32Array
  bounds: Bounds
  count: number
}

const BOUNDS: Bounds = { min: [0, 0, 0], max: [1000, 1000, 300] }

function ground(x: number, y: number): number {
  return 40 + 15 * Math.sin(x / 90) * Math.cos(y / 70) + 5 * Math.sin((x + y) / 23)
}

export function makeSyntheticCloud(count: number, seed = 1): SyntheticCloud {
  const rand = mulberry32(seed)
  const words = new Uint32Array(count * 2)
  const [mx, my, mz] = BOUNDS.min
  const [Mx, My, Mz] = BOUNDS.max

  for (let i = 0; i < count; i++) {
    const r = rand()
    let x = rand() * 1000
    let y = rand() * 1000
    let z: number
    let cls: number
    if (r < 0.1) {
      // building: snap XY to a 50 m grid cell footprint (30x30), roof or wall
      const cx = Math.floor(x / 50) * 50 + 10
      const cy = Math.floor(y / 50) * 50 + 10
      const h = 15 + ((Math.floor(x / 50) * 7 + Math.floor(y / 50) * 13) % 25)
      const base = ground(cx + 15, cy + 15)
      if (rand() < 0.6) {
        x = cx + rand() * 30; y = cy + rand() * 30; z = base + h
      } else {
        const side = rand()
        if (side < 0.5) { x = cx + (side < 0.25 ? 0 : 30); y = cy + rand() * 30 }
        else { x = cx + rand() * 30; y = cy + (side < 0.75 ? 0 : 30) }
        z = base + rand() * h
      }
      cls = 6
    } else if (r < 0.25) {
      // tree: column of noise above ground
      const tx = x, ty = y
      x = tx + (rand() - 0.5) * 6
      y = ty + (rand() - 0.5) * 6
      z = ground(tx, ty) + 3 + rand() * 12
      cls = 5
    } else {
      z = ground(x, y) + (rand() - 0.5) * 0.3
      cls = 2
    }
    const intensity = Math.floor(rand() * 256)
    const [w0, w1] = packWords(
      quantize(x, mx, Mx), quantize(y, my, My), quantize(z, mz, Mz), packAttr(intensity, cls),
    )
    words[i * 2] = w0
    words[i * 2 + 1] = w1
  }
  return { words, bounds: BOUNDS, count }
}
