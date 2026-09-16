export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export const QMAX = 65535

export function quantize(v: number, min: number, max: number): number {
  if (max === min) return 0
  const q = Math.round(((v - min) / (max - min)) * QMAX)
  return Math.min(QMAX, Math.max(0, q))
}

export function dequantize(q: number, min: number, max: number): number {
  return min + (q / QMAX) * (max - min)
}

export function dequantScale(b: Bounds): [number, number, number] {
  return [
    (b.max[0] - b.min[0]) / QMAX,
    (b.max[1] - b.min[1]) / QMAX,
    (b.max[2] - b.min[2]) / QMAX,
  ]
}

export function packAttr(intensity: number, cls: number): number {
  return (intensity & 0xff) | ((cls & 0xff) << 8)
}

export function unpackAttr(packed: number): { intensity: number; cls: number } {
  return { intensity: packed & 0xff, cls: (packed >>> 8) & 0xff }
}

/** Two little-endian u32 words per point: [x | y<<16, z | packed<<16]. Same bytes as v1 disk format. */
export function packWords(x: number, y: number, z: number, packed: number): [number, number] {
  return [((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0, ((z & 0xffff) | ((packed & 0xffff) << 16)) >>> 0]
}

export function unpackWords(w0: number, w1: number): [number, number, number, number] {
  return [w0 & 0xffff, (w0 >>> 16) & 0xffff, w1 & 0xffff, (w1 >>> 16) & 0xffff]
}
