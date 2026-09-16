import { Canvas, extend } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { OrbitControls } from '@react-three/drei'
import { SpikePoints } from './SpikePoints'
import { Hud } from './Hud'
import { spikeParams } from './params'

extend(THREE as any)

export function SpikeApp() {
  const { n, size } = spikeParams()
  if (!('gpu' in navigator)) {
    return <div style={{ padding: 16 }}>WebGPU not available in this browser.</div>
  }
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div id="hud" style={{ position: 'absolute', top: 8, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <div id="compute" style={{ position: 'absolute', top: 28, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <Canvas
        camera={{ position: [1500, 1200, 1500], near: 1, far: 20000, fov: 50, up: [0, 0, 1] }}
        onCreated={({ camera, gl }) => { (window as any).__spikeCamera = camera; (window as any).__spikeGl = gl }}
        gl={async (props) => {
          // Default maxStorageBufferBindingSize (128 MiB) is too small for the qpos storage
          // buffer at 20M points (160 MB); raise it so the flags compute pass's bind group is
          // valid. Query the adapter's actual limit rather than hard-coding a value: a fixed
          // requiredLimits request larger than what the adapter supports makes requestDevice
          // fail outright, so use exactly what this adapter reports (and fall back to no
          // requiredLimits if the adapter can't be queried at all). Only
          // maxStorageBufferBindingSize is raised: the compute-pass error cited only that limit,
          // and the default maxBufferSize (256 MiB) already covers the 160 MB position buffer.
          const adapter = await navigator.gpu.requestAdapter()
          const requiredLimits = adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : undefined
          const renderer = new THREE.WebGPURenderer({
            ...(props as Record<string, unknown>),
            antialias: false,
            trackTimestamp: true,
            ...(requiredLimits ? { requiredLimits } : {}),
          })
          await renderer.init()
          return renderer
        }}
      >
        <SpikePoints count={n} size={size} />
        <OrbitControls ref={(c) => { (window as any).__spikeControls = c }} target={[500, 500, 40]} makeDefault enableDamping />
        <Hud />
      </Canvas>
    </div>
  )
}
