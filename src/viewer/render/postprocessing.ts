import * as THREE from 'three/webgpu'
import { pass, uniform } from 'three/tsl'
import { edlShadeNode } from './edl'
import type { EdlState } from '../state/store'

export interface PostHandle {
  pipeline: THREE.RenderPipeline
  setEnabled(on: boolean): void
  setRadius(px: number): void
  setStrength(s: number): void
  render(camera: THREE.PerspectiveCamera, dpr: number): void
  dispose(): void
}

// One RenderPipeline per <Canvas>: scene → HalfFloat colour + depth pass → EDL → renderOutput (ACES + sRGB, once).
// `outputColorTransform` stays true so "off" (outputNode = scenePass) equals the plain canvas render within rounding.
export function createPostPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, init: EdlState): PostHandle {
  const scenePass = pass(scene, camera, { samples: 0 })      // HalfFloatType colour (PassNode default); depth is the DepthTexture default (24-bit) unless renderer.reversedDepthBuffer is on
  const colour = scenePass.getTextureNode('output')
  const depth = scenePass.getTextureNode('depth')
  const u = {
    radiusPx: uniform(init.radiusPx),
    strength: uniform(init.strength),
    near: uniform(0.1),
    far: uniform(1000),
    dpr: uniform(1),
  }
  const edl = edlShadeNode(colour, depth, u)
  const pipeline = new THREE.RenderPipeline(renderer, init.enabled ? edl : scenePass)
  let enabled = init.enabled

  return {
    pipeline,
    setEnabled(on) {
      if (on === enabled) return
      enabled = on
      pipeline.outputNode = on ? edl : scenePass
      pipeline.needsUpdate = true          // outputNode assignment alone does not rebuild the quad material
    },
    setRadius(px) { u.radiusPx.value = px },
    setStrength(s) { u.strength.value = s },
    render(cam, dpr) {
      u.near.value = cam.near
      u.far.value = cam.far
      u.dpr.value = dpr
      pipeline.render()
    },
    dispose() {
      pipeline.dispose()
      scenePass.dispose()                  // render target + depth texture
    },
  }
}
