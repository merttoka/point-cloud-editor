import { useStore, useViewerStore, type ColorMode, type Colormap, type EdlState } from '../state/store'
import styles from './Panel.module.css'

export function Panel() {
  const store = useViewerStore()
  const manifest = useStore((s) => s.manifest)
  const loaded = useStore((s) => s.loaded)
  const error = useStore((s) => s.error)
  const budget = useStore((s) => s.budget)
  const pointSize = useStore((s) => s.pointSize)
  const colorMode = useStore((s) => s.colorMode)
  const colormap = useStore((s) => s.colormap)
  const showHud = useStore((s) => s.showHud)
  const edl = useStore((s) => s.edl)

  const total = manifest?.pointCount ?? 0
  const frac = total ? loaded.points / total : 0
  const budgetPct = Math.round(budget * 100)
  const setEdl = (patch: Partial<EdlState>) => store.set({ edl: { ...store.get().edl, ...patch } })
  return (
    <div className={styles.panel}>
      <div className={styles.name}>{manifest?.name ?? 'loading…'}</div>
      <div className={styles.muted}>{loaded.points.toLocaleString()} / {total.toLocaleString()} pts · {loaded.chunks}/{manifest?.chunks.length ?? 0} chunks</div>
      <div className={styles.bar}><div className={styles.fill} style={{ width: `${frac * 100}%` }} /></div>
      {error && <div className={styles.muted}>{error}</div>}
      <label className={styles.row}><span>Budget</span><span>{budgetPct}%</span>
        <input type="range" min={0} max={100} step={1} value={budgetPct} onChange={(e) => store.set({ budget: Number(e.target.value) / 100 })} /></label>
      <label className={styles.row}><span>Point size</span><span>{pointSize}px</span>
        <input type="range" min={1} max={8} step={1} value={pointSize} onChange={(e) => store.set({ pointSize: Number(e.target.value) })} /></label>
      <label className={styles.row}><span>Colour</span>
        <select value={colorMode} onChange={(e) => store.set({ colorMode: e.target.value as ColorMode })}>
          <option value="height">Height</option><option value="intensity">Intensity</option><option value="class">Classification</option>
        </select></label>
      {colorMode !== 'class' && (
        <label className={styles.row}><span>Colormap</span>
          <select value={colormap} onChange={(e) => store.set({ colormap: e.target.value as Colormap })}>
            <option value="viridis">Viridis</option><option value="turbo">Turbo</option><option value="grayscale">Grayscale</option>
          </select></label>
      )}
      <div className={styles.group}>
        <div className={styles.groupTitle}>Lighting</div>
        <label className={styles.row}><span>EDL</span>
          <input type="checkbox" checked={edl.enabled} onChange={(e) => setEdl({ enabled: e.target.checked })} /></label>
        <label className={styles.row}><span>Radius</span><span>{edl.radiusPx.toFixed(1)}px</span>
          <input type="range" min={1} max={4} step={0.5} value={edl.radiusPx} disabled={!edl.enabled} onChange={(e) => setEdl({ radiusPx: Number(e.target.value) })} /></label>
        <label className={styles.row}><span>Strength</span><span>{edl.strength.toFixed(1)}</span>
          <input type="range" min={0} max={4} step={0.1} value={edl.strength} disabled={!edl.enabled} onChange={(e) => setEdl({ strength: Number(e.target.value) })} /></label>
      </div>
      <label className={styles.row}><span>HUD</span>
        <input type="checkbox" checked={showHud} onChange={(e) => store.set({ showHud: e.target.checked })} /></label>
    </div>
  )
}
