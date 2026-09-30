import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { createPostPipeline, type PostHandle } from './postprocessing'
import { useStore, useViewerStore } from '../state/store'
import type { ViewerApi } from './Scene'

// Owns the RenderPipeline. Built in a layout effect declared before useFrame (also a layout effect), so the handle
// exists before r3f can fire a frame; an effect rather than useMemo because StrictMode's mount→cleanup→mount would
// leak one pipeline. useFrame at priority 1 makes r3f skip its own gl.render (internal.priority > 0).
export function PostPass({ api }: { api: ViewerApi }) {
  const { gl, scene, camera } = useThree()
  const store = useViewerStore()
  const handle = useRef<PostHandle | null>(null)

  useLayoutEffect(() => {
    const h = createPostPipeline(gl as unknown as THREE.WebGPURenderer, scene, camera, store.get().edl)
    handle.current = h
    return () => { handle.current = null; h.dispose() }
  }, [gl, scene, camera, store])

  // Bench: GPU time of the next frame's render passes (scene pass + EDL quad) via the render timestamp query.
  useEffect(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    api.renderGpuMs = async () => {
      if (!r.hasFeature('timestamp-query')) return null
      await new Promise<void>((res) => requestAnimationFrame(() => res()))
      const ms = await r.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      return ms ?? null
    }
    // Bench: the point material's generated WGSL. A node whose first use sits inside a `select` branch is
    // materialised there, so anything outside the branch reads 0 (Phase 0 clip space, Phase 7 layer masks) —
    // dumping the shader is the only way to see it. `scripts/bench.md` has the check.
    api.shaderWgsl = async () => {
      const sprite = scene.children.find((o) => (o as THREE.Sprite).isSprite) as THREE.Sprite | undefined
      if (!sprite) return null
      const { vertexShader } = await r.debug.getShaderAsync(scene, camera, sprite)
      return vertexShader
    }
    return () => { api.renderGpuMs = undefined; api.shaderWgsl = undefined }
  }, [gl, scene, camera, api])

  const edl = useStore((s) => s.edl)
  useEffect(() => {
    const h = handle.current
    if (!h) return
    h.setEnabled(edl.enabled)
    h.setRadius(edl.radiusPx)
    h.setStrength(edl.strength)
  }, [edl])

  useFrame(() => handle.current?.render(camera, gl.getPixelRatio()), 1)

  return null
}
