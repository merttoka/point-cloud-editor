import { useRef, useState, type PointerEvent } from 'react'
import type { ViewerApi } from '../render/Scene'
import { useStore, useViewerStore } from '../state/store'
import { simplifyPoly, type Poly } from '../edit/lasso'
import styles from './LassoOverlay.module.css'

export function LassoOverlay({ api }: { api: ViewerApi }) {
  const store = useViewerStore()
  const tool = useStore((s) => s.edit.tool)
  const [poly, setPoly] = useState<Poly>([])
  const drawing = useRef(false)
  const local = (e: PointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const onDown = (e: PointerEvent<SVGSVGElement>) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); setPoly([local(e)]) }
  // Read the point before the updater runs: React nulls e.currentTarget once the handler returns.
  const onMove = (e: PointerEvent<SVGSVGElement>) => { if (!drawing.current) return; const pt = local(e); setPoly((p) => simplifyPoly([...p, pt], 2)) }
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    drawing.current = false
    const done = simplifyPoly([...poly, local(e)], 2)
    setPoly([])
    if (done.length >= 3) void api.lasso?.(done, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace')
  }
  if (tool !== 'lasso') return null
  return (
    <svg className={styles.overlay} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={() => { drawing.current = false; setPoly([]) }} onDoubleClick={() => store.set({ edit: { ...store.get().edit, tool: 'orbit' } })}>
      {poly.length > 1 && <polygon className={styles.poly} points={poly.map((p) => p.join(',')).join(' ')} />}
    </svg>
  )
}
