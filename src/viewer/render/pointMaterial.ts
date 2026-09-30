import * as THREE from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { abs, clamp, dot, float, instanceIndex, max, min, mix, normalize, positionView, select, step, texture, transformNormalToView, uniform, uint, userData, vec2, vec3, vertexStage } from 'three/tsl'
import type { PointBuffers } from './PointBuffers'
import { FLAG_HIDDEN, FLAG_DELETED, FLAG_SELECTED, FLAG_SPLIT_A, FLAG_SPLIT_B } from './PointBuffers'
import { centroidOf, type Manifest } from '../loader/manifest'
import { dequantScale, QMAX } from '../format/quant'
import { hexToRgb, makeLutTexture, type LutKind } from './colormaps'
import type { ColorMode, Colormap, Shading, ViewerState } from '../state/store'

export interface PointMaterialHandle {
  material: THREE.PointsNodeMaterial
  setLut(kind: LutKind): void
  setMode(mode: ColorMode): void
  setPointSize(px: number): void
  setRefDist(d: number): void
  setShading(mode: Shading): void
  setHighlight(selected: string): void   // CSS colour for the selection tint (split colours are fixed)
  setSegmentColor(id: number, color: string): void   // '#rrggbb' → segments LUT entry; entry 0 stays SEGMENT_NONE
  dispose(): void
}

const MODE: Record<ColorMode, number> = { height: 0, intensity: 1, class: 2, segments: 3 }
const SHADING: Record<Shading, number> = { flat: 0, lit: 1, litAo: 2, normals: 3 }

export const lutKindFor = (mode: ColorMode, colormap: Colormap): LutKind => mode === 'class' || mode === 'segments' ? mode : colormap

// `init` seeds the uniforms/LUT from the store snapshot so the material never carries its own copy of the defaults.
export function createPointMaterial(
  buffers: PointBuffers, manifest: Manifest, init: Pick<ViewerState, 'pointSize' | 'colorMode' | 'colormap' | 'shading'>,
): PointMaterialHandle {
  const b = manifest.bounds
  const centroid = centroidOf(b)
  const dqScale = uniform(new THREE.Vector3(...dequantScale(b)))
  const dqMinCentred = uniform(new THREE.Vector3(b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]))
  const pointSize = uniform(init.pointSize)
  const refDist = uniform(1000)
  const mode = uniform(MODE[init.colorMode])
  const shading = uniform(SHADING[init.shading])

  // Global point index: per-object chunk base + instance index. Read in the vertex stage only.
  // userData()'s declared return type is UserDataNode (Node<unknown>), which the TSL Node<T>
  // type alias intersects to {} for arithmetic ops when T is unknown; cast to Node<'uint'> to
  // recover .add (the runtime object is proxy-wrapped with the operator regardless of the type).
  const gi = (userData('chunkBase', 'uint') as unknown as Node<'uint'>).add(instanceIndex)
  const w = buffers.qposNode.element(gi)
  const x = w.x.bitAnd(uint(0xffff))
  const y = w.x.shiftRight(uint(16))
  const z = w.y.bitAnd(uint(0xffff))
  const packed = w.y.shiftRight(uint(16))
  const intensity = packed.bitAnd(uint(0xff))
  const cls = w.y.shiftRight(uint(24)).bitAnd(uint(0xff))

  // Byte `gi` of a u8-packed word buffer (flags, ao): word gi >> 2, shift (gi & 3) * 8.
  const byteOf = (words: PointBuffers['flagsNode']) => words.element(gi.shiftRight(uint(2))).shiftRight(gi.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))
  const fbyte = byteOf(buffers.flagsNode)
  const shown = float(1).sub(step(0.5, float(fbyte.bitAnd(uint(FLAG_HIDDEN | FLAG_DELETED)))))   // 0 hidden/deleted, else 1
  const bitF = (bit: number) => float(fbyte.bitAnd(uint(bit))).div(bit)                   // 0 or 1, branchless
  const tint = vertexStage(vec3(bitF(FLAG_SELECTED), bitF(FLAG_SPLIT_A), bitF(FLAG_SPLIT_B)))
  // uniform(Color) is linear; new Color('#hex') decodes sRGB under the default ColorManagement, matching the LUT path.
  const cSel = uniform(new THREE.Color('#bf1656')), cA = uniform(new THREE.Color('#2ec4b6')), cB = uniform(new THREE.Color('#ff9f1c'))

  // Layer masks (render/layerMasks.ts): word 0 class bit, words 1..8 segment bit. Both 0/1 → one multiply on the size term,
  // so a masked point collapses exactly like a hidden one (A8) and no branch touches positionView.
  // min()'s declared type only covers float/vecN (three's MathNode.d.ts: "TODO Allow int/uint"); the runtime node is
  // dynamically typed regardless, so cast like the userData() read above.
  const minU = min as unknown as (a: Node<'uint'>, b: Node<'uint'>) => Node<'uint'>
  const mw = buffers.masks.node
  // Own reads, not `cls` / the `tS` segment byte: those are first used inside the colour-mode `select` branches, so
  // the builder materialises them there and the size term (after the branch) would read 0 outside the matching mode —
  // every point would take class 0's / segment 0's bit (ARCHITECTURE "Phase 0 spike findings"; check in scripts/bench.md).
  const clsOwn = buffers.qposNode.element(gi).y.shiftRight(uint(24)).bitAnd(uint(0xff))
  const segOwn = byteOf(buffers.segIdsNode)
  const clsBit = mw.element(uint(0)).shiftRight(minU(clsOwn, uint(31))).bitAnd(uint(1))
  const segBit = mw.element(segOwn.shiftRight(uint(5)).add(uint(1))).shiftRight(segOwn.bitAnd(uint(31))).bitAnd(uint(1))
  const layerVisible = float(clsBit.mul(segBit))

  // Oct-decoded normal and AO byte (compute outputs), vertex-stage reads like qpos/flags.
  const nw = buffers.normalsNode.element(gi)
  const fx = float(nw.bitAnd(uint(0xffff))).div(65535).mul(2).sub(1)
  const fy = float(nw.shiftRight(uint(16))).div(65535).mul(2).sub(1)
  const nz = float(1).sub(abs(fx)).sub(abs(fy))
  const fold = nz.lessThan(0)
  const ox = select(fold, float(1).sub(abs(fy)).mul(select(fx.greaterThanEqual(0), 1, -1)), fx)
  const oy = select(fold, float(1).sub(abs(fx)).mul(select(fy.greaterThanEqual(0), 1, -1)), fy)
  const normalObj = normalize(vec3(ox, oy, nz))
  const nView = normalize(transformNormalToView(normalObj))
  const viewDir = normalize(positionView.negate())
  const SUN = normalize(vec3(-0.4, -0.3, 0.85))                  // world, +Z up; fixed key light from above-left
  const wrap = float(0.30).add(abs(dot(nView, viewDir)).mul(0.45))
  const sun = max(dot(normalObj, SUN), 0).mul(0.25)
  const lambert = wrap.add(sun)                                   // 0.30 … 1.0
  const aoByte = float(byteOf(buffers.aoNode)).div(255)
  // Branchless blend: select() compiles to if/else and the builder then emits the first (shared) evaluation of
  // positionView/modelViewMatrix inside one branch, leaving them unassigned on the others (clip space reads them).
  const lit = step(0.5, shading)                                 // 1 for lit / litAo / normals
  const useAo = step(1.5, shading)                               // 1 for litAo / normals (normals overrides colour below)
  const debugNormals = step(2.5, shading)                        // 1 for normals
  const aoTerm = mix(float(1), aoByte.sqrt(), useAo)              // sqrt: occlusion shades, never masks
  const light = mix(float(1), lambert.mul(aoTerm), lit)

  const material = new THREE.PointsNodeMaterial()
  material.sizeAttenuation = false
  material.positionNode = vec3(float(x), float(y), float(z)).mul(dqScale).add(dqMinCentred)
  // Hidden/deleted/masked → size 0 collapses the quad (the factors sit outside the clamp, so the 1 px floor can't revive
  // it). Multiplies, not select(): a branch here would hold the first read of positionView.
  const sizePx = clamp(pointSize.mul(refDist).div(positionView.z.negate()), 1, 8)
  material.sizeNode = sizePx.mul(shown).mul(layerVisible)

  // Colour: t chosen per mode; wrapped in vertexStage so the storage reads stay in the vertex stage.
  const tH = float(z).div(QMAX)
  const tI = float(intensity).div(255)
  const tC = float(cls).div(255)
  const tS = float(byteOf(buffers.segIdsNode)).div(255)
  const t = select(mode.equal(1), tI, select(mode.equal(2), tC, select(mode.equal(3), tS, tH)))
  const luts = new Map<LutKind, THREE.DataTexture>()
  const lutFor = (kind: LutKind) => {
    let tex = luts.get(kind)
    if (!tex) { tex = makeLutTexture(kind); luts.set(kind, tex) }
    return tex
  }
  const lutNode = texture(lutFor(lutKindFor(init.colorMode, init.colormap)), vec2(vertexStage(t), 0.5))
  const base = mix(lutNode.mul(vertexStage(light)), vertexStage(abs(normalObj)), debugNormals)
  material.colorNode = mix(mix(mix(base, cSel, tint.x.mul(0.7)), cA, tint.y), cB, tint.z)

  return {
    material,
    setLut: (kind) => { lutNode.value = lutFor(kind) },
    setMode: (m) => { mode.value = MODE[m] },
    setPointSize: (px) => { pointSize.value = px },
    setRefDist: (d) => { refDist.value = d },
    setShading: (m) => { shading.value = SHADING[m] },
    setHighlight: (selected) => { cSel.value.set(selected) },
    setSegmentColor: (id, color) => {
      const tex = lutFor('segments')
      ;(tex.image.data as Uint8Array).set([...hexToRgb(color), 255], id * 4)
      tex.needsUpdate = true
    },
    dispose: () => { luts.forEach((t) => t.dispose()); material.dispose() },
  }
}
