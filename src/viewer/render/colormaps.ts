import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, SRGBColorSpace } from 'three/webgpu'

type RGB = [number, number, number]
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

// Viridis polynomial fit (M. Zucker, degree 6), sRGB in [0,1]
const V = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
]
export function viridis(t: number): RGB {
  t = clamp01(t)
  const out: RGB = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    let v = V[6][ch]
    for (let k = 5; k >= 0; k--) v = V[k][ch] + t * v
    out[ch] = clamp01(v)
  }
  return out
}

// Turbo polynomial approximation (Google, A. Mikhailov), sRGB in [0,1]
const TR4 = [0.13572138, 4.6153926, -42.66032258, 132.13108234], TR2 = [-152.94239396, 59.28637943]
const TG4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333], TG2 = [4.27729857, 2.82956604]
const TB4 = [0.1066733, 12.64194608, -60.58204836, 110.36276771], TB2 = [-89.90310912, 27.34824973]
export function turbo(t: number): RGB {
  const x = clamp01(t)
  const v4 = [1, x, x * x, x * x * x], v2 = [x ** 4, x ** 5]
  const ev = (a: number[], b: number[]) => a[0] * v4[0] + a[1] * v4[1] + a[2] * v4[2] + a[3] * v4[3] + b[0] * v2[0] + b[1] * v2[1]
  return [clamp01(ev(TR4, TR2)), clamp01(ev(TG4, TG2)), clamp01(ev(TB4, TB2))]
}

export function grayscale(t: number): RGB {
  const v = clamp01(t)
  return [v, v, v]
}

// ASPRS classes → sRGB bytes; -1 is the fallback for classes not listed
export const ASPRS_COLORS: Record<number, RGB> = {
  [-1]: [106, 106, 106],
  0: [77, 77, 77],      // never classified
  1: [154, 154, 154],   // unclassified
  2: [160, 120, 75],    // ground
  3: [127, 191, 77],    // low vegetation
  4: [86, 163, 62],     // medium vegetation
  5: [47, 125, 50],     // high vegetation
  6: [224, 160, 64],    // building
  7: [255, 59, 208],    // low noise
  9: [47, 128, 237],    // water
  17: [192, 192, 192],  // bridge deck   (addition beyond the spec's minimum list)
  18: [255, 59, 208],   // high noise    (addition beyond the spec's minimum list)
}

export type LutKind = 'viridis' | 'turbo' | 'grayscale' | 'class'

export function buildLut(kind: LutKind): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    let rgb: RGB
    if (kind === 'class') {
      const c = ASPRS_COLORS[i] ?? ASPRS_COLORS[-1]
      rgb = [c[0] / 255, c[1] / 255, c[2] / 255]
    } else {
      const f = kind === 'viridis' ? viridis : kind === 'turbo' ? turbo : grayscale
      rgb = f(i / 255)
    }
    out[i * 4] = Math.round(rgb[0] * 255)
    out[i * 4 + 1] = Math.round(rgb[1] * 255)
    out[i * 4 + 2] = Math.round(rgb[2] * 255)
    out[i * 4 + 3] = 255
  }
  return out
}

export function makeLutTexture(kind: LutKind): DataTexture {
  const tex = new DataTexture(buildLut(kind), 256, 1, RGBAFormat, UnsignedByteType)
  tex.colorSpace = SRGBColorSpace      // values are sRGB; decoded on sample (rgba8unorm-srgb)
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}
