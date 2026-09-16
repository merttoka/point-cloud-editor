import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'

export function Hud() {
  const { gl } = useThree()
  const ema = useRef(16)
  const last = useRef(performance.now())
  useFrame(() => {
    const now = performance.now()
    const dt = now - last.current
    last.current = now
    ema.current = ema.current * 0.9 + dt * 0.1
    const el = document.getElementById('hud')
    if (!el) return
    // three's internal rAF (Animation.js) resets info every tick when autoReset is on,
    // racing r3f's loop → always 0. Own the reset: read previous frame's counters, then clear.
    const info = (gl as unknown as WebGPURenderer).info
    info.autoReset = false
    el.textContent =
      `${ema.current.toFixed(2)} ms  ${(1000 / ema.current).toFixed(0)} fps` +
      `  draws ${info.render.drawCalls}  pts ${info.render.points}  tris ${info.render.triangles}`
    info.reset()
  })
  return null
}
