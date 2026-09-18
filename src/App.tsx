import { PointCloudViewer } from './viewer/PointCloudViewer'

// Dev harness only: `?data=full` swaps to the 20M set (perf rows).
const params = new URLSearchParams(window.location.search)
const dataset = params.get('data') === 'full' ? 'full' : 'demo'

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`/data/${dataset}/manifest.json`} />
    </div>
  )
}
