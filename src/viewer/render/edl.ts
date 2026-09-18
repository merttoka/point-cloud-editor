import type { Node, TextureNode, UniformNode } from 'three/webgpu'
import { Fn, exp, float, log2, max, perspectiveDepthToViewZ, screenSize, select, uv, vec2 } from 'three/tsl'

// Eye-dome lighting (Boucheny 2009): darken each pixel by how much closer its screen-space neighbours are, in
// log depth. The TS functions are the reference the TSL node mirrors; vitest covers them, the browser covers the node.

export const EDL_TAPS = 8
export const EDL_SCALE = 300          // Boucheny's constant; keeps strength ≈ 1 sensible at radius ≈ 1.5 px
const BACKGROUND = 0.999             // -viewZ >= far * BACKGROUND → empty sky

export function edlObscurance(centre: number, taps: number[], near: number, far: number): number {
  const bg = far * BACKGROUND
  if (centre >= bg) return 0
  const d0 = Math.log2(Math.max(centre, near))
  let obs = 0
  for (const t of taps) {
    if (t >= bg) continue                                   // background tap: treated as d_k = d0
    obs += Math.max(0, d0 - Math.log2(Math.max(t, near)))
  }
  return obs / taps.length
}

export function edlShade(obs: number, strength: number, radiusPx: number): number {
  return Math.exp(-strength * obs * EDL_SCALE / radiusPx)
}

export interface EdlUniforms {
  radiusPx: UniformNode<'float', number>
  strength: UniformNode<'float', number>
  near: UniformNode<'float', number>
  far: UniformNode<'float', number>
  dpr: UniformNode<'float', number>
}

const DIRS = Array.from({ length: EDL_TAPS }, (_, k) => {
  const a = (k * Math.PI * 2) / EDL_TAPS
  return [Math.cos(a), Math.sin(a)] as const
})

// colour: the pass colour texture node; depthTex: `scenePass.getTextureNode('depth')` (raw depth, sampled at offsets).
// Runs in the pipeline quad's fragment stage, where `uv()` is the screen uv and `screenSize` the drawing-buffer size.
export function edlShadeNode(colour: Node<'vec4'>, depthTex: TextureNode, u: EdlUniforms): Node {
  return Fn(() => {
    const uv0 = uv()
    const bg = u.far.mul(BACKGROUND)
    const viewDist = (at: Node<'vec2'>) => perspectiveDepthToViewZ(depthTex.sample(at).r, u.near, u.far).negate()
    const logDepth = (dist: Node<'float'>) => log2(max(dist, u.near))

    const c = viewDist(uv0).toVar()
    const d0 = logDepth(c).toVar()
    const offPx = u.radiusPx.mul(u.dpr).div(screenSize)      // vec2, uv units per physical px * radius
    let obs: Node<'float'> = float(0)
    for (const [dx, dy] of DIRS) {
      const dist = viewDist(uv0.add(vec2(dx, dy).mul(offPx)))
      const dk = select(dist.greaterThanEqual(bg), d0, logDepth(dist))
      obs = obs.add(max(float(0), d0.sub(dk)))
    }
    obs = obs.div(EDL_TAPS)
    const shade = exp(u.strength.mul(obs).mul(EDL_SCALE).div(u.radiusPx).negate())
    const shadeOrSky = select(c.greaterThanEqual(bg), float(1), shade)
    return colour.mul(shadeOrSky)
  })()
}
