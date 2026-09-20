import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Manifest } from '../loader/manifest'

export type ColorMode = 'height' | 'intensity' | 'class'
export type Colormap = 'viridis' | 'turbo' | 'grayscale'

export interface EdlState { enabled: boolean; radiusPx: number; strength: number }

export type Shading = 'flat' | 'lit' | 'litAo' | 'normals'
export interface PassTiming { pass: string; submitMs: number; gpuMs: number | null }
export interface ComputeState {
  status: 'idle' | 'running' | 'built' | 'error'
  radiusMul: number            // slider, × spacing
  builtRadius: number | null   // metres, radius the current normals/ao were built with
  timings: PassTiming[]
  elapsedMs: number | null
  error?: string
}
export interface VerifyResult { n: number; medianDeg: number; maxDeg: number; aoMae: number; nonFinite: number; degenerate: number }
export interface BenchState {
  status: 'idle' | 'running' | 'done' | 'cancelled'
  progress: number             // 0..1
  n: number
  cpuMs: { hash: number; normals: number; ao: number } | null
  verify: VerifyResult | null
}

export type SelectMode = 'replace' | 'add' | 'subtract'
export type EditTool = 'orbit' | 'lasso'
export type SplitSide = 'all' | 'A' | 'B'
export interface EditState {
  tool: EditTool
  busy: boolean
  counts: { selected: number; hidden: number; deleted: number; split: number }
  undoDepth: number
  redoDepth: number
  splitSide: SplitSide
  split: { fitted: boolean; inlierRatio: number | null }
  lasso: { gpuMs: number | null; readbackMs: number; selected: number } | null
  pickMs: number | null
  message?: string
}

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
  edl: EdlState
  shading: Shading
  compute: ComputeState
  bench: BenchState
  edit: EditState
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
  edl: { enabled: true, radiusPx: 1.5, strength: 1 },
  shading: 'flat',
  compute: { status: 'idle', radiusMul: 6, builtRadius: null, timings: [], elapsedMs: null },
  bench: { status: 'idle', progress: 0, n: 0, cpuMs: null, verify: null },
  edit: {
    tool: 'orbit',
    busy: false,
    counts: { selected: 0, hidden: 0, deleted: 0, split: 0 },
    undoDepth: 0,
    redoDepth: 0,
    splitSide: 'all',
    split: { fitted: false, inlierRatio: null },
    lasso: null,
    pickMs: null,
  },
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
