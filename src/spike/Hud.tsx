import { useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'

export function Hud({ el }: { el: RefObject<HTMLDivElement | null> }) {
  const { gl } = useThree()
  const info = (gl as unknown as WebGPURenderer).info
  const ema = useRef(16)
  const last = useRef(performance.now())
  // info.autoReset is disabled where the renderer is created (SpikeApp gl factory); this loop
  // reads the previous frame's counters, then clears them.
  useFrame(() => {
    const now = performance.now()
    const dt = now - last.current
    last.current = now
    ema.current = ema.current * 0.9 + dt * 0.1
    if (!el.current) return
    el.current.textContent =
      `${ema.current.toFixed(2)} ms  ${(1000 / ema.current).toFixed(0)} fps` +
      `  draws ${info.render.drawCalls}  pts ${info.render.points}  tris ${info.render.triangles}`
    info.reset()
  })
  return null
}
