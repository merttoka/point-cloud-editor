import { useEffect, useState } from 'react'
import { PointCloudViewer, type BenchHandle } from './viewer/PointCloudViewer'
import { parseHarnessParams, themeFromMessage, type Theme } from './harness'

// Harness: `?data=<name>` picks `public/data/<name>/` (`full` = 20M set, `export` = a re-opened export); `?dpr=` overrides
// the canvas pixel ratio; `?bench=1` exposes window.__pcv; `?theme=` sets the initial theme, the Lab page updates it by postMessage.
const params = parseHarnessParams(window.location.search)
const attach = (h: BenchHandle) => { (window as unknown as { __pcv?: unknown }).__pcv = h }

export function App() {
  const [theme, setTheme] = useState<Theme>(params.theme)
  useEffect(() => {
    const on = (e: MessageEvent) => { const t = themeFromMessage(e, window.location.origin); if (t) setTheme(t) }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <PointCloudViewer manifestUrl={`${import.meta.env.BASE_URL}data/${params.dataset}/manifest.json`} dpr={params.dpr} theme={theme} onApi={params.bench ? attach : undefined} />
    </div>
  )
}
