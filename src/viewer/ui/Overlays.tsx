import { Fragment } from 'react'
import { useStore } from '../state/store'
import styles from './Overlays.module.css'

export const KEYS: [string, string][] = [
  ['drag / wheel', 'orbit / zoom'],
  ['F', 'refit camera to dataset'],
  ['H', 'toggle HUD'],
  ['\\ (hold)', 'this list'],
]

export function KeysOverlay() {
  return (
    <div className={styles.card}>
      <div className={styles.title}>Keys</div>
      <div className={styles.keys}>{KEYS.map(([k, v]) => <Fragment key={k}><kbd>{k}</kbd><span>{v}</span></Fragment>)}</div>
    </div>
  )
}

// Centred progress card while the manifest + chunks stream in; unmounts on ready/error.
export function LoadingOverlay() {
  const manifest = useStore((s) => s.manifest)
  const loaded = useStore((s) => s.loaded)
  const total = manifest?.pointCount ?? 0
  const frac = total ? loaded.points / total : 0
  return (
    <div className={styles.card}>
      <div className={styles.title}>{manifest?.name ?? 'Loading…'}</div>
      <div className={styles.bar}><div className={styles.fill} style={{ width: `${frac * 100}%` }} /></div>
      <div className={styles.muted}>{Math.round(frac * 100)}% · {loaded.points.toLocaleString()} / {total.toLocaleString()} pts · {loaded.chunks}/{manifest?.chunks.length ?? 0} chunks</div>
    </div>
  )
}
