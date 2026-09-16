import { useMemo, useRef, type KeyboardEvent } from 'react'
import { StoreContext, createStore, initialState, useStore, useViewerStore } from './state/store'
import { useLoader } from './loader/useLoader'
import { Scene, type ViewerApi } from './render/Scene'
import { Panel } from './ui/Panel'
import styles from './PointCloudViewer.module.css'
import tokens from './theme/tokens.module.css'

export interface PointCloudViewerProps {
  manifestUrl: string
  theme?: 'dark' | 'light'
  className?: string
}

// One store per viewer instance, provided via context so several viewers can coexist on a page.
export function PointCloudViewer(props: PointCloudViewerProps) {
  const store = useMemo(() => createStore(initialState), [])
  return (
    <StoreContext.Provider value={store}>
      <ViewerInner {...props} />
    </StoreContext.Provider>
  )
}

function ViewerInner({ manifestUrl, theme, className }: PointCloudViewerProps) {
  const store = useViewerStore()
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const hudEl = useRef<HTMLDivElement>(null)
  const api = useRef<ViewerApi>({ fit: () => {} }).current
  const loaded = useLoader(store, manifestUrl, api)
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator

  // Keys live on the root only (focus-scoped); nothing is attached to window/document.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'f' || e.key === 'F') { api.fit(); e.preventDefault() }
    if (e.key === 'h' || e.key === 'H') { store.set({ showHud: !store.get().showHud }); e.preventDefault() }
  }

  return (
    <div className={`${tokens.root} ${styles.root} ${className ?? ''}`} data-theme={theme} tabIndex={0} onKeyDown={onKeyDown}>
      <div id="hud" ref={hudEl} className={styles.hud} />
      <Panel handle={loaded?.handle ?? null} />
      {!hasGpu && <div className={styles.message}>WebGPU not available in this browser.</div>}
      {hasGpu && status === 'error' && <div className={styles.message}>{error}</div>}
      {hasGpu && status !== 'error' && loaded && (
        <Scene store={store} buffers={loaded.buffers} manifest={loaded.manifest} handle={loaded.handle}
          centroid={loaded.centroid} api={api} hudEl={hudEl} />
      )}
    </div>
  )
}
