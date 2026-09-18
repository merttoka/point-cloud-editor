import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three/webgpu'
import { createPostPipeline, type PostHandle } from './postprocessing'
import { useStore, useViewerStore } from '../state/store'

// Owns the RenderPipeline. Built in a layout effect declared before useFrame (also a layout effect), so the handle
// exists before r3f can fire a frame; an effect rather than useMemo because StrictMode's mount→cleanup→mount would
// leak one pipeline. useFrame at priority 1 makes r3f skip its own gl.render (internal.priority > 0).
export function PostPass() {
  const { gl, scene, camera } = useThree()
  const store = useViewerStore()
  const handle = useRef<PostHandle | null>(null)

  useLayoutEffect(() => {
    const h = createPostPipeline(gl as unknown as THREE.WebGPURenderer, scene, camera, store.get().edl)
    handle.current = h
    return () => { handle.current = null; h.dispose() }
  }, [gl, scene, camera, store])

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
