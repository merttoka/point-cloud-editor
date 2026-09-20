import { patchEdit, useStore, useViewerStore, type SplitSide } from '../state/store'
import type { ViewerApi } from '../render/Scene'
import type { Editor } from '../edit/editor'
import styles from './Toolbar.module.css'

interface BtnProps { label: string; on: () => void; ready: boolean; disabled?: boolean; active?: boolean; title?: string }
// Module-level so React keeps the button identity across renders (a per-render component would remount on every store change).
function Btn({ label, on, ready, disabled, active, title }: BtnProps) {
  // mousedown prevented so a click leaves focus on the viewer root (keys stay scoped there); the <select> keeps default behaviour.
  return <button className={styles.btn} data-active={active} disabled={!ready || disabled} onClick={on} onMouseDown={(e) => e.preventDefault()} title={title}>{label}</button>
}

export function Toolbar({ editor, api }: { editor: Editor | null; api: ViewerApi }) {
  const store = useViewerStore()
  const edit = useStore((s) => s.edit)
  const status = useStore((s) => s.status)
  const ready = status === 'ready' && !!editor && !edit.busy
  const hasSel = edit.counts.selected > 0
  const setEdit = (p: Partial<typeof edit>) => patchEdit(store, p)
  return (
    <div className={styles.bar}>
      <Btn ready={ready} label="Orbit" active={edit.tool === 'orbit'} on={() => setEdit({ tool: 'orbit' })} title="Esc" />
      <Btn ready={ready} label="Lasso" active={edit.tool === 'lasso'} on={() => setEdit({ tool: 'lasso' })} title="L" />
      <span className={styles.sep} />
      <Btn ready={ready} label="Isolate" disabled={!hasSel} on={() => editor?.isolate()} title="I" />
      <Btn ready={ready} label="Hide" disabled={!hasSel} on={() => editor?.hide()} title="X" />
      <Btn ready={ready} label="Delete" disabled={!hasSel} on={() => editor?.del()} title="Delete" />
      <Btn ready={ready} label="Unhide all" disabled={edit.counts.hidden === 0} on={() => editor?.unhideAll()} title="U" />
      <Btn ready={ready} label="Clear" disabled={!hasSel} on={() => editor?.clearSelection()} title="C" />
      <span className={styles.sep} />
      <Btn ready={ready} label="Split" disabled={edit.counts.selected < 3} on={() => editor?.split()} title="S" />
      <select className={styles.select} value={edit.splitSide} disabled={!edit.split.fitted} onChange={(e) => setEdit({ splitSide: e.target.value as SplitSide })}>
        <option value="all">Both sides</option><option value="A">Side A</option><option value="B">Side B</option>
      </select>
      <span className={styles.sep} />
      <Btn ready={ready} label="Undo" disabled={edit.undoDepth === 0} on={() => editor?.undo()} title="⌘Z" />
      <Btn ready={ready} label="Redo" disabled={edit.redoDepth === 0} on={() => editor?.redo()} title="⇧⌘Z" />
      <Btn ready={ready} label="Export" disabled={!api.exportZip} on={() => void api.exportZip?.()} />
      <span className={styles.muted}>sel {edit.counts.selected.toLocaleString()} · hidden {edit.counts.hidden.toLocaleString()} · deleted {edit.counts.deleted.toLocaleString()}</span>
      {edit.lasso && <span className={styles.muted}>lasso {edit.lasso.gpuMs?.toFixed(2) ?? 'n/a'} ms gpu · {edit.lasso.readbackMs.toFixed(0)} ms readback</span>}
      {edit.pickMs !== null && <span className={styles.muted}>pick {edit.pickMs.toFixed(1)} ms</span>}
      {edit.message && <span className={styles.muted}>{edit.message}</span>}
    </div>
  )
}
