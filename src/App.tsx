import { PointCloudViewer } from './viewer/PointCloudViewer'

// Dev harness only: `?data=<name>` picks `public/data/<name>/` (`full` = 20M perf set, `export` = a re-opened export);
// `?dpr=` overrides the canvas pixel ratio.
const params = new URLSearchParams(window.location.search)
const dataParam = params.get('data') ?? ''
const dataset = /^[a-z0-9-]+$/.test(dataParam) ? dataParam : 'demo'
const dprParam = Number(params.get('dpr'))
const dpr = Number.isFinite(dprParam) && dprParam > 0 ? Math.min(4, Math.max(0.5, dprParam)) : undefined

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`/data/${dataset}/manifest.json`} dpr={dpr} />
    </div>
  )
}
