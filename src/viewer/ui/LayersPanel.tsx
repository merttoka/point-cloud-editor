import { useState, type MouseEvent, type SyntheticEvent } from 'react'
import { useStore, type Segment } from '../state/store'
import type { Editor } from '../edit/editor'
import type { Layer } from '../edit/layers'
import { ASPRS_COLORS, ASPRS_NAMES } from '../render/colormaps'
import { modeFromEvent } from './keys'
import styles from './LayersPanel.module.css'

// Row click → selectLayer (⇧ add, ⌥ subtract), double-click → solo, eye → visibility. Buttons prevent mousedown so focus
// (and the key map) stays on the viewer root; the name/colour inputs keep default focus and stop the row handlers.
const stop = (e: SyntheticEvent) => e.stopPropagation()
const keepFocus = (e: MouseEvent) => e.preventDefault()

export function LayersPanel({ editor }: { editor: Editor | null }) {
  const manifest = useStore((s) => s.manifest)
  const layers = useStore((s) => s.layers)
  const selected = useStore((s) => s.edit.counts.selected)
  const busy = useStore((s) => s.edit.busy)
  const status = useStore((s) => s.status)
  const [open, setOpen] = useState(true)
  const ready = status === 'ready' && !!editor && !busy
  const classes = Object.keys(layers.classCounts).map(Number).sort((a, b) => a - b)
  const className = (c: number) => manifest?.classMap[String(c)] ?? ASPRS_NAMES[c] ?? `Class ${c}`
  const classRgb = (c: number) => { const [r, g, b] = ASPRS_COLORS[c] ?? ASPRS_COLORS[-1]; return `rgb(${r}, ${g}, ${b})` }
  const select = (layer: Layer) => (e: MouseEvent) => { if (editor && ready) editor.selectLayer(layer, modeFromEvent(e)) }
  const solo = (layer: Layer) => () => editor?.soloLayer(layer)
  const toggle = (layer: Layer, visible: boolean) => (e: MouseEvent) => { stop(e); editor?.setLayerVisible(layer, !visible) }
  return (
    <div className={styles.card}>
      <button className={styles.header} onMouseDown={keepFocus} onClick={() => setOpen((o) => !o)}>Layers <span>{open ? '−' : '+'}</span></button>
      {open && (
        <>
          <div className={styles.groupTitle}>Classes</div>
          {classes.length === 0 && <div className={styles.muted}>Counted when the load finishes.</div>}
          {classes.map((c) => {
            const visible = layers.classVisible[c] !== false
            return (
              <div key={c} className={styles.row} data-hidden={!visible} onMouseDown={keepFocus} onClick={select({ class: c })} onDoubleClick={solo({ class: c })} title="click: select · ⇧ add · ⌥ subtract · double-click: solo">
                <span className={styles.swatch} style={{ background: classRgb(c) }} />
                <span className={styles.name}>{className(c)}</span>
                <span className={styles.count}>{layers.classCounts[c].toLocaleString()}</span>
                <button className={styles.icon} title={visible ? 'Hide' : 'Show'} onMouseDown={keepFocus} onClick={toggle({ class: c }, visible)} onDoubleClick={stop}>{visible ? '●' : '○'}</button>
              </div>
            )
          })}
          <div className={styles.groupTitle}>Segments</div>
          {layers.segments.length === 0 && <div className={styles.muted}>Select points, then save them as a segment.</div>}
          {layers.segments.map((s) => (
            <SegmentRow key={s.id} s={s} editor={editor} ready={ready} onSelect={select({ segment: s.id })} onSolo={solo({ segment: s.id })} onToggle={toggle({ segment: s.id }, s.visible)} />
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

function SegmentRow({ s, editor, ready, onSelect, onSolo, onToggle }: {
  s: Segment; editor: Editor | null; ready: boolean; onSelect: (e: MouseEvent) => void; onSolo: () => void; onToggle: (e: MouseEvent) => void
}) {
  return (
    <div className={`${styles.row} ${styles.segRow}`} data-hidden={!s.visible} onMouseDown={keepFocus} onClick={onSelect} onDoubleClick={onSolo} title="click: select · ⇧ add · ⌥ subtract · double-click: solo">
      <label className={styles.swatch} style={{ background: s.color }} onMouseDown={stop} onClick={stop} onDoubleClick={stop} title="Colour">
        <input type="color" value={s.color} onChange={(e) => editor?.setSegmentColor(s.id, e.target.value)} />
      </label>
      <input className={styles.nameInput} value={s.name} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onChange={(e) => editor?.renameSegment(s.id, e.target.value)} title="Rename" />
      <span className={styles.count}>{s.count.toLocaleString()}</span>
      <button className={styles.icon} title={s.visible ? 'Hide' : 'Show'} onMouseDown={keepFocus} onClick={onToggle} onDoubleClick={stop}>{s.visible ? '●' : '○'}</button>
      <button className={styles.icon} title="Delete segment" disabled={!ready} onMouseDown={keepFocus} onClick={(e) => { stop(e); editor?.deleteSegment(s.id) }} onDoubleClick={stop}>×</button>
    </div>
  )
}
