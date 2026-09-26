import { useEffect, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'
import { useStore, useViewerStore } from '../state/store'
import type { ViewerApi } from '../render/Scene'

export function Hud({ el, api }: { el: RefObject<HTMLDivElement | null>; api: ViewerApi }) {
  const { gl } = useThree()
  const info = (gl as unknown as WebGPURenderer).info
  const store = useViewerStore()
  const show = useStore((s) => s.showHud)
  const ema = useRef(16)
  const last = useRef(performance.now())
  const draws = useRef(0)
  useEffect(() => {
    api.frame = () => {
      const canvas = (gl as unknown as WebGPURenderer).domElement
      return { ms: ema.current, fps: 1000 / ema.current, draws: draws.current, width: canvas.clientWidth, height: canvas.clientHeight, dpr: gl.getPixelRatio() }
    }
    api.canvas = () => (gl as unknown as WebGPURenderer).domElement
    return () => { api.frame = undefined; api.canvas = undefined }
  }, [api, gl])
  // info.autoReset is off (renderer factory); read the previous frame's counters, then clear them.
  useFrame(() => {
    const now = performance.now()
    ema.current = ema.current * 0.9 + (now - last.current) * 0.1
    last.current = now
    draws.current = info.render.drawCalls
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
