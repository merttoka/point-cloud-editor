import { useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'
import { useStore, useViewerStore } from '../state/store'

export function Hud({ el }: { el: RefObject<HTMLDivElement | null> }) {
  const { gl } = useThree()
  const info = (gl as unknown as WebGPURenderer).info
  const store = useViewerStore()
  const show = useStore((s) => s.showHud)
  const ema = useRef(16)
  const last = useRef(performance.now())
  // info.autoReset is off (renderer factory); read the previous frame's counters, then clear them.
  useFrame(() => {
    const now = performance.now()
    ema.current = ema.current * 0.9 + (now - last.current) * 0.1
    last.current = now
    if (!el.current) return
    const { loaded, manifest, budget } = store.get()
    el.current.textContent = show
      ? `${ema.current.toFixed(2)} ms  ${(1000 / ema.current).toFixed(0)} fps  draws ${info.render.drawCalls}  tris ${info.render.triangles}` +
        `  loaded ${loaded.points.toLocaleString()}/${(manifest?.pointCount ?? 0).toLocaleString()}  budget ${Math.round(budget * 100)}%`
      : ''
    info.reset()
  })
  return null
}
