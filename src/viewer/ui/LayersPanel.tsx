import { useState, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { useStore } from '../state/store'
import type { Editor } from '../edit/editor'
import type { Layer } from '../edit/layers'
import { ASPRS_COLORS, ASPRS_NAMES } from '../render/colormaps'
import { modeFromEvent } from './keys'
import styles from './LayersPanel.module.css'

// Row click → selectLayer (⇧ add, ⌥ subtract), double-click → solo, eye → visibility. Buttons prevent mousedown so focus
// (and the key map) stays on the viewer root; the name/colour inputs keep default focus and stop the row handlers.
const stop = (e: SyntheticEvent) => e.stopPropagation()
const keepFocus = (e: MouseEvent) => e.preventDefault()
const ROW_HINT = 'click: select · ⇧ add · ⌥ subtract · double-click: solo'

export function LayersPanel({ editor }: { editor: Editor | null }) {
  const manifest = useStore((s) => s.manifest)
  const layers = useStore((s) => s.layers)
  const selected = useStore((s) => s.edit.counts.selected)
  const busy = useStore((s) => s.edit.busy)
  const status = useStore((s) => s.status)
  const [open, setOpen] = useState(true)
  const ready = status === 'ready' && !!editor && !busy
  const classes = Object.keys(layers.classCounts).map(Number).sort((a, b) => a - b)
  const classLabel = (c: number) => manifest?.classMap[String(c)] ?? ASPRS_NAMES[c] ?? `Class ${c}`
  const classRgb = (c: number) => { const [r, g, b] = ASPRS_COLORS[c] ?? ASPRS_COLORS[-1]; return `rgb(${r}, ${g}, ${b})` }
  return (
    <div className={styles.card}>
      <button className={styles.header} onMouseDown={keepFocus} onClick={() => setOpen((o) => !o)}>Layers <span>{open ? '−' : '+'}</span></button>
      {open && (
        <>
          <div className={styles.groupTitle}>Classes</div>
          {classes.length === 0 && <div className={styles.muted}>Counted when the load finishes.</div>}
          {classes.map((c) => (
            <LayerRow key={c} layer={{ class: c }} visible={layers.classVisible[c] !== false} count={layers.classCounts[c]} editor={editor} ready={ready}>
              <span className={styles.swatch} style={{ background: classRgb(c) }} />
              <span className={styles.name}>{classLabel(c)}</span>
            </LayerRow>
          ))}
          <div className={styles.groupTitle}>Segments</div>
          {layers.segments.length === 0 && <div className={styles.muted}>Select points, then save them as a segment.</div>}
          {layers.segments.map((s) => (
            <LayerRow key={s.id} layer={{ segment: s.id }} visible={s.visible} count={s.count} editor={editor} ready={ready} className={styles.segRow}
              extra={<button className={styles.icon} title="Delete segment" disabled={!ready} onMouseDown={keepFocus} onClick={(e) => { stop(e); editor?.deleteSegment(s.id) }} onDoubleClick={stop}>×</button>}>
              <label className={styles.swatch} style={{ background: s.color }} onMouseDown={stop} onClick={stop} onDoubleClick={stop} title="Colour">
                <input type="color" value={s.color} onChange={(e) => editor?.setSegmentColor(s.id, e.target.value)} />
              </label>
              <input className={styles.nameInput} value={s.name} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onChange={(e) => editor?.renameSegment(s.id, e.target.value)} title="Rename" />
            </LayerRow>
          ))}
          <div className={styles.footer}>
            <button className={styles.button} disabled={!ready || selected === 0} onMouseDown={keepFocus} onClick={() => editor?.saveSegment()}>Save selection as segment</button>
            <button className={styles.button} disabled={!editor} onMouseDown={keepFocus} onClick={() => editor?.showAllLayers()}>Show all</button>
          </div>
        </>
      )}
    </div>
  )
}

// Swatch + name arrive as children, then count and eye; `extra` trails (the segment delete button).
function LayerRow({ layer, visible, count, editor, ready, className = '', extra, children }: {
  layer: Layer; visible: boolean; count: number; editor: Editor | null; ready: boolean; className?: string; extra?: ReactNode; children: ReactNode
}) {
  return (
    <div className={`${styles.row} ${className}`} data-hidden={!visible} onMouseDown={keepFocus} title={ROW_HINT}
      onClick={(e) => { if (editor && ready) editor.selectLayer(layer, modeFromEvent(e)) }} onDoubleClick={() => editor?.soloLayer(layer)}>
      {children}
      <span className={styles.count}>{count.toLocaleString()}</span>
      <button className={styles.icon} title={visible ? 'Hide' : 'Show'} onMouseDown={keepFocus} onClick={(e) => { stop(e); editor?.setLayerVisible(layer, !visible) }} onDoubleClick={stop}>{visible ? '●' : '○'}</button>
      {extra}
    </div>
  )
}
