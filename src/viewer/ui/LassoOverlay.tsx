import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { ViewerApi } from '../render/Scene'
import { patchEdit, useStore, useViewerStore } from '../state/store'
import { decimatePoly, simplifyPoly, type Poly } from '../edit/lasso'
import { modeFromEvent } from './keys'
import styles from './LassoOverlay.module.css'

export function LassoOverlay({ api }: { api: ViewerApi }) {
  const store = useViewerStore()
  const tool = useStore((s) => s.edit.tool)
  const [poly, setPoly] = useState<Poly>([])
  const drawing = useRef(false)
  useEffect(() => { if (tool !== 'lasso') { drawing.current = false; setPoly([]) } }, [tool])   // Esc mid-drag drops the polygon
  const local = (e: PointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const onDown = (e: PointerEvent<SVGSVGElement>) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); setPoly([local(e)]) }
  // Read the point before the updater runs: React nulls e.currentTarget once the handler returns.
  const onMove = (e: PointerEvent<SVGSVGElement>) => { if (!drawing.current) return; const pt = local(e); setPoly((p) => simplifyPoly([...p, pt], 2)) }
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    drawing.current = false
    const done = decimatePoly(simplifyPoly([...poly, local(e)], 2))
    setPoly([])
    if (done.length >= 3) void api.lasso?.(done, modeFromEvent(e))
  }
  if (tool !== 'lasso') return null
  return (
    <svg className={styles.overlay} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={() => { drawing.current = false; setPoly([]) }} onDoubleClick={() => patchEdit(store, { tool: 'orbit' })}>
      {poly.length > 1 && <polygon className={styles.poly} points={poly.map((p) => p.join(',')).join(' ')} />}
    </svg>
  )
}
