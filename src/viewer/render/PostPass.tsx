import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three/webgpu'
import { createPostPipeline, type PostHandle } from './postprocessing'
import { useViewerStore } from '../state/store'

// Owns the RenderPipeline. Built in an effect (StrictMode runs mount→cleanup→mount; useMemo would leak one pipeline).
// useFrame at priority 1 makes r3f skip its own gl.render (internal.priority > 0); the pipeline is the sole renderer.
export function PostPass() {
  const { gl, scene, camera } = useThree()
  const store = useViewerStore()
  const handle = useRef<PostHandle | null>(null)

  useEffect(() => {
    const h = createPostPipeline(gl as unknown as THREE.WebGPURenderer, scene, camera, store.get().edl)
    handle.current = h
    const apply = () => {
      const { enabled, radiusPx, strength } = store.get().edl
      h.setEnabled(enabled)      // no-op unless changed; other store traffic (chunk loads) costs three uniform writes
      h.setRadius(radiusPx)
      h.setStrength(strength)
    }
    apply()
    const unsubscribe = store.subscribe(apply)
    return () => { unsubscribe(); handle.current = null; h.dispose() }
  }, [gl, scene, camera, store])

  useFrame(() => {
    const h = handle.current
    if (h) h.render(camera as THREE.PerspectiveCamera, gl.getPixelRatio())
    else gl.render(scene, camera)     // between effect cleanup and re-run (StrictMode) keep drawing
  }, 1)

  return null
}
