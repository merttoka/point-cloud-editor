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
    return () => { api.renderGpuMs = undefined }
  }, [gl, api])

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
