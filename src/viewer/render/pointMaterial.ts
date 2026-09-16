import * as THREE from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { clamp, float, instanceIndex, positionView, select, texture, uniform, uint, userData, vec2, vec3, vertexStage } from 'three/tsl'
import type { PointBuffers } from './PointBuffers'
import { FLAG_HIDDEN, FLAG_DELETED } from './PointBuffers'
import { centroidOf, type Manifest } from '../loader/manifest'
import { dequantScale, QMAX } from '../format/quant'
import { makeLutTexture, type LutKind } from './colormaps'
import type { ColorMode, ViewerState } from '../state/store'

export interface PointMaterialHandle {
  material: THREE.PointsNodeMaterial
  setLut(kind: LutKind): void
  setMode(mode: ColorMode): void
  setPointSize(px: number): void
  setRefDist(d: number): void
  dispose(): void
}

const MODE: Record<ColorMode, number> = { height: 0, intensity: 1, class: 2 }

// `init` seeds the uniforms/LUT from the store snapshot so the material never carries its own copy of the defaults.
export function createPointMaterial(
  buffers: PointBuffers, manifest: Manifest, init: Pick<ViewerState, 'pointSize' | 'colorMode' | 'colormap'>,
): PointMaterialHandle {
  const b = manifest.bounds
  const centroid = centroidOf(b)
  const dqScale = uniform(new THREE.Vector3(...dequantScale(b)))
  const dqMinCentred = uniform(new THREE.Vector3(b.min[0] - centroid[0], b.min[1] - centroid[1], b.min[2] - centroid[2]))
  const pointSize = uniform(init.pointSize)
  const refDist = uniform(1000)
  const mode = uniform(MODE[init.colorMode])

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
  const cls = packed.shiftRight(uint(8)).bitAnd(uint(0xff))

  const fword = buffers.flagsNode.element(gi.shiftRight(uint(2)))
  const fbyte = fword.shiftRight(gi.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))
  const collapsed = fbyte.bitAnd(uint(FLAG_HIDDEN | FLAG_DELETED)).notEqual(uint(0))

  const material = new THREE.PointsNodeMaterial()
  material.sizeAttenuation = false
  material.positionNode = vec3(float(x), float(y), float(z)).mul(dqScale).add(dqMinCentred)
  // Hidden/deleted → size 0 collapses the quad (select sits outside the clamp, so the 1 px floor can't revive it).
  const sizePx = clamp(pointSize.mul(refDist).div(positionView.z.negate()), 1, 8)
  material.sizeNode = select(collapsed, float(0), sizePx)

  // Colour: t chosen per mode; wrapped in vertexStage so the storage reads stay in the vertex stage.
  const tH = float(z).div(QMAX)
  const tI = float(intensity).div(255)
  const tC = float(cls).div(255)
  const t = select(mode.equal(1), tI, select(mode.equal(2), tC, tH))
  const luts = new Map<LutKind, THREE.DataTexture>()
  const lutFor = (kind: LutKind) => {
    let tex = luts.get(kind)
    if (!tex) { tex = makeLutTexture(kind); luts.set(kind, tex) }
    return tex
  }
  const lutNode = texture(lutFor(init.colorMode === 'class' ? 'class' : init.colormap), vec2(vertexStage(t), 0.5))
  material.colorNode = lutNode

  return {
    material,
    setLut: (kind) => { lutNode.value = lutFor(kind) },
    setMode: (m) => { mode.value = MODE[m] },
    setPointSize: (px) => { pointSize.value = px },
    setRefDist: (d) => { refDist.value = d },
    dispose: () => { luts.forEach((t) => t.dispose()); material.dispose() },
  }
}
