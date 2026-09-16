import { useRef } from 'react'
import { Canvas, extend } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { OrbitControls } from '@react-three/drei'
import { SpikePoints } from './SpikePoints'
import { Hud } from './Hud'
import { spikeParams } from './params'

extend(THREE as any)

export function SpikeApp() {
  const { n, size } = spikeParams()
  const hudEl = useRef<HTMLDivElement>(null)
  const computeEl = useRef<HTMLDivElement>(null)
  if (!('gpu' in navigator)) {
    return <div style={{ padding: 16 }}>WebGPU not available in this browser.</div>
  }
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div id="hud" ref={hudEl} style={{ position: 'absolute', top: 8, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <div id="compute" ref={computeEl} style={{ position: 'absolute', top: 28, left: 8, zIndex: 1, whiteSpace: 'pre' }} />
      <Canvas
        camera={{ position: [1500, 1200, 1500], near: 1, far: 20000, fov: 50, up: [0, 0, 1] }}
        onCreated={({ camera, gl }) => { (window as any).__spikeCamera = camera; (window as any).__spikeGl = gl }}
        gl={async (props) => {
          // The qpos storage binding is 160 MB at 20M points, over the 128 MiB default
          // maxStorageBufferBindingSize. Request the adapter's own limit (asking for more than it
          // supports fails requestDevice), using the same adapter options as WebGPUBackend.init so
          // the limit belongs to the adapter three actually creates the device on.
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
          // Hud owns info.reset() (three's Animation rAF would otherwise clear counters each tick).
          renderer.info.autoReset = false
          return renderer
        }}
      >
        <SpikePoints count={n} size={size} statusEl={computeEl} />
        <OrbitControls ref={(c) => { (window as any).__spikeControls = c }} target={[500, 500, 40]} makeDefault enableDamping />
        <Hud el={hudEl} />
      </Canvas>
    </div>
  )
}
