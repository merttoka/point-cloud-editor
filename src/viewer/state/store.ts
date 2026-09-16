import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Manifest } from '../loader/manifest'

export type ColorMode = 'height' | 'intensity' | 'class'
export type Colormap = 'viridis' | 'turbo' | 'grayscale'

export interface ViewerState {
  manifest: Manifest | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  loaded: { points: number; chunks: number }
  budget: number
  pointSize: number
  colorMode: ColorMode
  colormap: Colormap
  showHud: boolean
}

export const initialState: ViewerState = {
  manifest: null,
  status: 'idle',
  loaded: { points: 0, chunks: 0 },
  budget: 1,
  pointSize: 2,
  colorMode: 'height',
  colormap: 'viridis',
  showHud: true,
}

export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(fn: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      subs.forEach((fn) => fn())
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
}

export const StoreContext = createContext<Store<ViewerState> | null>(null)

export function useViewerStore(): Store<ViewerState> {
  const s = useContext(StoreContext)
  if (!s) throw new Error('useViewerStore outside <PointCloudViewer>')
  return s
}

export function useStore<S>(selector: (s: ViewerState) => S): S {
  const store = useViewerStore()
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()))
}
