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
          const renderer = new THREE.WebGPURenderer({
            ...(props as Record<string, unknown>),
            antialias: false,
            trackTimestamp: true,
            // Default maxStorageBufferBindingSize (128 MiB) is too small for the qpos storage
            // buffer at 20M points (160 MB); raise it so the flags compute pass's bind group is
            // valid. 1 GiB is comfortably under the adapter's reported max (~4 GiB on M4 Max).
            requiredLimits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
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
