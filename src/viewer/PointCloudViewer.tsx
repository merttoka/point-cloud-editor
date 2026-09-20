import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { StoreContext, createStore, initialState, useStore, useViewerStore } from './state/store'
import { useLoader } from './loader/useLoader'
import { Scene, type ViewerApi } from './render/Scene'
import { Panel } from './ui/Panel'
import { KeysOverlay, LoadingOverlay } from './ui/Overlays'
import styles from './PointCloudViewer.module.css'
import tokens from './theme/tokens.module.css'

export interface PointCloudViewerProps {
  manifestUrl: string
  theme?: 'dark' | 'light'
  className?: string
  dpr?: number            // canvas pixel ratio override (default: device)
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

function ViewerInner({ manifestUrl, theme, className, dpr }: PointCloudViewerProps) {
  const store = useViewerStore()
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const hudEl = useRef<HTMLDivElement>(null)
  const api = useRef<ViewerApi>({ fit: () => {} }).current
  const loaded = useLoader(manifestUrl, api)
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  const [showKeys, setShowKeys] = useState(false)      // held `\`; transient, so not in the store

  // Keys live on the root only (focus-scoped); nothing is attached to window/document.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'f' || e.key === 'F') { api.fit(); e.preventDefault() }
    if (e.key === 'h' || e.key === 'H') { store.set({ showHud: !store.get().showHud }); e.preventDefault() }
    if (e.code === 'Backslash') { if (!e.repeat) setShowKeys(true); e.preventDefault() }   // code, not key: stable across AltGr layouts on keyup
  }
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => { if (e.code === 'Backslash') setShowKeys(false) }
  // Root onBlur is focusout: skip focus moves between descendants (Panel controls) so a held `\` stays shown.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShowKeys(false) }

  const message = !hasGpu ? 'WebGPU not available in this browser.' : status === 'error' ? error : null
  return (
    <div className={`${tokens.root} ${styles.root} ${className ?? ''}`} data-theme={theme} data-pcv-root tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={onBlur}>
      <div id="hud" ref={hudEl} className={styles.hud} />
      <Panel api={api} />
      {showKeys && <KeysOverlay />}
      {message === null && status !== 'ready' && !error && <LoadingOverlay />}
      {message !== null ? <div className={styles.message}>{message}</div>
        : loaded && <Scene buffers={loaded.buffers} manifest={loaded.manifest} handle={loaded.handle} api={api} hudEl={hudEl} dpr={dpr} />}
    </div>
  )
}
