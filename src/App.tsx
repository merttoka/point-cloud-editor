import { PointCloudViewer } from './viewer/PointCloudViewer'

// Dev harness only: `?data=full` swaps to the 20M set (perf rows); `?dpr=` overrides the canvas pixel ratio.
const params = new URLSearchParams(window.location.search)
const dataset = params.get('data') === 'full' ? 'full' : 'demo'
const dprParam = Number(params.get('dpr'))
const dpr = Number.isFinite(dprParam) && dprParam > 0 ? Math.min(4, Math.max(0.5, dprParam)) : undefined

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`/data/${dataset}/manifest.json`} dpr={dpr} />
    </div>
  )
}
