import { PointCloudViewer, type BenchHandle } from './viewer/PointCloudViewer'

// Dev harness only: `?data=<name>` picks `public/data/<name>/` (`full` = 20M perf set, `export` = a re-opened export);
// `?dpr=` overrides the canvas pixel ratio; `?bench=1` exposes the bench handle as `window.__pcv`.
const params = new URLSearchParams(window.location.search)
const dataParam = params.get('data') ?? ''
const dataset = /^[a-z0-9-]+$/.test(dataParam) ? dataParam : 'demo'
const dprParam = Number(params.get('dpr'))
const dpr = Number.isFinite(dprParam) && dprParam > 0 ? Math.min(4, Math.max(0.5, dprParam)) : undefined
const bench = params.get('bench') === '1'
const attach = (h: BenchHandle) => { (window as unknown as { __pcv?: unknown }).__pcv = h }   // module scope: onApi must be stable

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`${import.meta.env.BASE_URL}data/${dataset}/manifest.json`} dpr={dpr} onApi={bench ? attach : undefined} />
    </div>
  )
}
