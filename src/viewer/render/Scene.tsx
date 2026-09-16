import { useEffect, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import type { Store, ViewerState } from '../state/store'
import { ChunkSprites } from './ChunkSprites'
import { Hud } from '../ui/Hud'

export interface ViewerApi {
  fit: () => void
  sendCamera?: (pos: [number, number, number]) => void
}

function fitDistance(manifest: Manifest, fovDeg: number): number {
  const b = manifest.bounds
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2]
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
  return radius / Math.sin((fovDeg * Math.PI) / 360) * 1.1
}

function CameraRig({ manifest, handle, api }: { manifest: Manifest; handle: PointMaterialHandle; api: ViewerApi }) {
  const { camera } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const lastSent = useRef(0)
  useEffect(() => {
    const fit = () => {
      const cam = camera as THREE.PerspectiveCamera
      const d = fitDistance(manifest, cam.fov)
      const dir = new THREE.Vector3(1, -1, 0.8).normalize()
      cam.position.copy(dir.multiplyScalar(d))
      cam.near = d / 1000
      cam.far = d * 10
      cam.updateProjectionMatrix()
      controls.current?.target.set(0, 0, 0)
      controls.current?.update()
      handle.setRefDist(d)
    }
    api.fit = fit
    fit()
  }, [camera, manifest, handle, api])
  // Throttled camera position to the loader (100 ms) for chunk prioritisation.
  useFrame(() => {
    const now = performance.now()
    if (now - lastSent.current < 100 || !api.sendCamera) return
    lastSent.current = now
    api.sendCamera([camera.position.x, camera.position.y, camera.position.z])
  })
  return <OrbitControls ref={controls} makeDefault enableDamping />
}

export function Scene({ store, buffers, manifest, handle, centroid, api, hudEl }: {
  store: Store<ViewerState>; buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle
  centroid: [number, number, number]; api: ViewerApi; hudEl: RefObject<HTMLDivElement | null>
}) {
  return (
    <Canvas
      camera={{ position: [1, -1, 0.8], near: 0.1, far: 10000, fov: 50, up: [0, 0, 1] }}
      gl={async (props) => {
        // Same adapter options as WebGPUBackend.init; request the adapter's own storage-binding limit (phase 0).
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: props.powerPreference as GPUPowerPreference,
          featureLevel: 'compatibility',
        })
        const renderer = new THREE.WebGPURenderer({
          ...(props as Record<string, unknown>),
          antialias: false,
          trackTimestamp: true,
          requiredLimits: adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : undefined,
        })
        await renderer.init()
        renderer.info.autoReset = false   // Hud owns info.reset()
        const maxBinding = adapter?.limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024
        const compat = (renderer.backend as unknown as { compatibilityMode: boolean | null }).compatibilityMode
        if (compat) store.set({ status: 'error', error: 'WebGPU compatibility mode not supported (no storage buffers in the vertex stage).' })
        else if (buffers.count * 8 > maxBinding) store.set({ status: 'error', error: `Dataset too large for this GPU: ${buffers.count.toLocaleString()} points need ${(buffers.count * 8 / 2 ** 20).toFixed(0)} MiB in one storage binding, limit ${(maxBinding / 2 ** 20).toFixed(0)} MiB.` })
        return renderer
      }}
    >
      <ChunkSprites buffers={buffers} manifest={manifest} handle={handle} centroid={centroid} />
      <CameraRig manifest={manifest} handle={handle} api={api} />
      <Hud el={hudEl} />
    </Canvas>
  )
}
