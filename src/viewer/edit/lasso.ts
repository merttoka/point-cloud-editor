export const MAX_LASSO_VERTS = 256
export type Poly = [number, number][]

// Even-odd crossing test, identical to the WGSL `pcvInPoly` in compute/wgsl/select.ts (edge i–j, j = previous vertex).
export function pointInPolygon(x: number, y: number, poly: Float32Array, count: number): boolean {
  let inside = false
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function polyBounds(poly: Float32Array, count: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const x = poly[i * 2], y = poly[i * 2 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

export function packPoly(poly: Poly): { data: Float32Array; count: number } {
  const count = Math.min(poly.length, MAX_LASSO_VERTS)
  const data = new Float32Array(MAX_LASSO_VERTS * 2)
  for (let i = 0; i < count; i++) { data[i * 2] = poly[i][0]; data[i * 2 + 1] = poly[i][1] }
  return { data, count }
}

// Long strokes: keep every step-th vertex (first always kept) so the shape survives the 256-vertex cap instead of being cut off.
export function decimatePoly(poly: Poly, max = MAX_LASSO_VERTS): Poly {
  if (poly.length <= max) return poly
  const step = Math.ceil(poly.length / max)
  const out: Poly = []
  for (let i = 0; i < poly.length; i += step) out.push(poly[i])
  return out
}

export function simplifyPoly(poly: Poly, minDistPx: number): Poly {
  const out: Poly = []
  for (const p of poly) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDistPx) out.push(p)
  }
  return out
}
