import { PointCloudViewer } from './viewer/PointCloudViewer'

export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl="/data/demo/manifest.json" />
    </div>
  )
}
