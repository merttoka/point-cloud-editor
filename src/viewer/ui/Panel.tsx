import { Fragment } from 'react'
import { useStore, useViewerStore, type ColorMode, type Colormap, type EdlState, type Shading } from '../state/store'
import type { ViewerApi } from '../render/Scene'
import { spacingOf } from '../compute/params'
import styles from './Panel.module.css'

export function Panel({ api }: { api: ViewerApi }) {
  const store = useViewerStore()
  const manifest = useStore((s) => s.manifest)
  const status = useStore((s) => s.status)
  const loaded = useStore((s) => s.loaded)
  const error = useStore((s) => s.error)
  const budget = useStore((s) => s.budget)
  const pointSize = useStore((s) => s.pointSize)
  const colorMode = useStore((s) => s.colorMode)
  const colormap = useStore((s) => s.colormap)
  const showHud = useStore((s) => s.showHud)
  const edl = useStore((s) => s.edl)
  const compute = useStore((s) => s.compute)
  const shading = useStore((s) => s.shading)

  const total = manifest?.pointCount ?? 0
  const spacing = manifest ? spacingOf(manifest.bounds, manifest.pointCount) : 0
  const radius = compute.radiusMul * spacing
  const canBuild = status === 'ready' && compute.status !== 'running' && (compute.status !== 'built' || compute.builtRadius !== radius)
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
      <div className={styles.group}>
        <div className={styles.groupTitle}>Compute</div>
        <div className={styles.muted}>All {total.toLocaleString()} points, independent of budget.</div>
        <label className={styles.row}><span>Radius</span><span>{compute.radiusMul.toFixed(1)}× = {radius.toFixed(2)} m</span>
          <input type="range" min={1} max={6} step={0.5} value={compute.radiusMul} disabled={compute.status === 'running'}
            onChange={(e) => store.set({ compute: { ...store.get().compute, radiusMul: Number(e.target.value) } })} /></label>
        <button className={styles.button} disabled={!canBuild} onClick={() => api.build?.(radius)}>
          {compute.status === 'running' ? 'Building…' : compute.status === 'built' && compute.builtRadius === radius ? 'Built' : 'Build normals + AO'}
        </button>
        {compute.status === 'error' && <div className={styles.muted}>{compute.error}</div>}
        {compute.timings.length > 0 && (
          <div className={styles.table}>
            <span>pass</span><span>submit</span><span>gpu</span>
            {compute.timings.map((t) => <Fragment key={t.pass}><span>{t.pass}</span><span>{t.submitMs.toFixed(2)}</span><span>{t.gpuMs === null ? 'n/a' : t.gpuMs.toFixed(2)}</span></Fragment>)}
            <span>total</span><span>{compute.timings.reduce((a, t) => a + t.submitMs, 0).toFixed(2)}</span>
            <span>{compute.timings.some((t) => t.gpuMs === null) ? 'n/a' : compute.timings.reduce((a, t) => a + (t.gpuMs ?? 0), 0).toFixed(2)}</span>
            <span className={styles.muted}>wall</span><span /><span>{compute.elapsedMs?.toFixed(0)} ms</span>
          </div>
        )}
        <label className={styles.row}><span>Shading</span>
          <select value={shading} onChange={(e) => store.set({ shading: e.target.value as Shading })}>
            <option value="flat">Flat</option>
            <option value="lit" disabled={compute.status !== 'built'}>Normal-lit</option>
            <option value="litAo" disabled={compute.status !== 'built'}>Lit + AO</option>
          </select></label>
      </div>
      <label className={styles.row}><span>HUD</span>
        <input type="checkbox" checked={showHud} onChange={(e) => store.set({ showHud: e.target.checked })} /></label>
    </div>
  )
}
