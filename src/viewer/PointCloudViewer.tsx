import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { StoreContext, createStore, initialState, patchEdit, useStore, useViewerStore, type EditTool } from './state/store'
import { useLoader } from './loader/useLoader'
import { Scene, type ViewerApi } from './render/Scene'
import { Panel } from './ui/Panel'
import { KeysOverlay, LoadingOverlay } from './ui/Overlays'
import { Toolbar } from './ui/Toolbar'
import { LassoOverlay } from './ui/LassoOverlay'
import { keyAction, modeFromEvent } from './ui/keys'
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
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'SELECT' || tag === 'INPUT') return   // Panel controls keep their own key behaviour
    if (e.code === 'Backslash') { if (!e.repeat) setShowKeys(true); e.preventDefault(); return }   // code, not key: stable across AltGr layouts on keyup
    const action = keyAction(e)
    if (!action) return
    const editor = loaded?.editor   // gates itself on status/busy
    const setTool = (tool: EditTool) => patchEdit(store, { tool })
    switch (action) {
      case 'fit': api.fit(); break
      case 'hud': store.set({ showHud: !store.get().showHud }); break
      case 'lasso': setTool(store.get().edit.tool === 'lasso' ? 'orbit' : 'lasso'); break
      case 'escape': setTool('orbit'); break
      case 'isolate': editor?.isolate(); break
      case 'hide': editor?.hide(); break
      case 'delete': editor?.del(); break
      case 'unhideAll': editor?.unhideAll(); break
      case 'clearSelection': editor?.clearSelection(); break
      case 'split': editor?.split(); break
      case 'undo': editor?.undo(); break
      case 'redo': editor?.redo(); break
    }
    e.preventDefault()
  }
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => { if (e.code === 'Backslash') setShowKeys(false) }
  // Root onBlur is focusout: skip focus moves between descendants (Panel controls) so a held `\` stays shown.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShowKeys(false) }

  // Click pick (orbit tool): down/up on the canvas within 4 px, coordinates in canvas CSS px.
  const down = useRef<{ x: number; y: number } | null>(null)
  const canvasPos = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.tagName !== 'CANVAS') return null
    const r = t.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => { down.current = e.button === 0 && store.get().edit.tool === 'orbit' ? canvasPos(e) : null }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = down.current; down.current = null
    if (e.button !== 0) return
    const p = canvasPos(e)
    if (!d || !p || Math.hypot(p.x - d.x, p.y - d.y) > 4) return
    void api.pick?.(p.x, p.y, modeFromEvent(e))
  }

  // Selection tint follows the theme accent; read from this root so several viewers each get their own.
  const rootEl = useRef<HTMLDivElement>(null)
  const [accent, setAccent] = useState('')
  useEffect(() => { if (rootEl.current) setAccent(getComputedStyle(rootEl.current).getPropertyValue('--pcv-accent').trim()) }, [theme])

  const message = !hasGpu ? 'WebGPU not available in this browser.' : status === 'error' ? error : null
  return (
    <div className={`${tokens.root} ${styles.root} ${className ?? ''}`} data-theme={theme} ref={rootEl} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={onBlur} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <div id="hud" ref={hudEl} className={styles.hud} />
      {loaded && <LassoOverlay api={api} />}
      <Panel api={api} />
      <Toolbar editor={loaded?.editor ?? null} api={api} />
      {showKeys && <KeysOverlay />}
      {message === null && status !== 'ready' && !error && <LoadingOverlay />}
      {message !== null ? <div className={styles.message}>{message}</div>
        : loaded && <Scene buffers={loaded.buffers} manifest={loaded.manifest} handle={loaded.handle} editor={loaded.editor} api={api} hudEl={hudEl} dpr={dpr} accent={accent} />}
    </div>
  )
}
