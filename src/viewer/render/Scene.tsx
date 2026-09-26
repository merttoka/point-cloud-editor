import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree, type GLProps } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import { BYTES_PER_POINT } from '../format/quant'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import { useViewerStore, type Store, type ViewerState } from '../state/store'
import { ChunkSprites } from './ChunkSprites'
import { Hud } from '../ui/Hud'
import { PostPass } from './PostPass'
import { ComputeRunner } from '../compute/ComputeRunner'
import type { ComputePipeline } from '../compute/pipeline'
import { EditRunner } from '../edit/EditRunner'
import type { Editor } from '../edit/editor'
import type { ViewParams } from '../edit/selectPipeline'
import type { Poly } from '../edit/lasso'
import type { SelectMode } from '../state/store'

export interface ViewerApi {
  fit: () => void
  sendCamera?: (pos: [number, number, number]) => void
  build?: (radius: number) => Promise<void>
  readback?: ComputePipeline['readback']
  cpuBench?: (radius: number) => Promise<{ normals: Uint32Array; ao: Uint8Array; n: number } | null>   // null = cancelled
  cancelBench?: () => void
  pick?: (x: number, y: number, mode: SelectMode) => Promise<void>       // GPU pick at CSS px → editor.pick, edit.pickMs
  lasso?: (poly: Poly, mode: SelectMode) => Promise<void>                // GPU lasso at CSS px → flags mirror, edit.lasso
  exportZip?: () => Promise<void>                                        // worker compaction + zip → download
  viewParams?: () => ViewParams                                           // the matrices the GPU kernels used (bench CPU reference)
  // Bench-only slots (read by bench/handle.ts; producers clear them on unmount).
  cpuPick?: (x: number, y: number) => number | null                      // CPU reference for the pick kernel
  cpuLasso?: (poly: Poly) => Uint32Array                                 // CPU reference for the lasso kernel
  classStats?: () => Promise<ClassStats>                                 // per-class normals/AO stats over the last build
  renderGpuMs?: () => Promise<number | null>                             // next frame's render-pass GPU ms
  frame?: () => FrameRow                                                 // Hud's EMA
  orbit?: (steps?: number, ms?: number) => Promise<void>                // scripted full turn around the target
  uploadLog?: () => number[]                                            // per-chunk GPU upload ms
  canvas?: () => HTMLCanvasElement | null                               // renderer's canvas (record())
}
export interface FrameRow { ms: number; fps: number; draws: number; width: number; height: number; dpr: number }
export type ClassStats = Record<number, { n: number; nzHist: number[]; aoMean: number }>   // |n.z| histogram (10 bins) + mean AO per class

const HOME_FOV = 50
const HOME_DIR = new THREE.Vector3(1, -1, 0.8).normalize()

// The pose `fit` frames the dataset from (single source: the loader seeds its chunk queue with the same one).
export function homePose(manifest: Manifest, fovDeg = HOME_FOV): { dist: number; pos: [number, number, number] } {
  const b = manifest.bounds
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2]
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
  const dist = radius / Math.sin((fovDeg * Math.PI) / 360) * 1.1
  return { dist, pos: [HOME_DIR.x * dist, HOME_DIR.y * dist, HOME_DIR.z * dist] }
}

function CameraRig({ manifest, handle, api }: { manifest: Manifest; handle: PointMaterialHandle; api: ViewerApi }) {
  const { camera } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const lastSent = useRef(0)
  useEffect(() => {
    const fit = () => {
      const cam = camera as THREE.PerspectiveCamera
      const { dist: d, pos } = homePose(manifest, cam.fov)
      cam.position.set(...pos)
      cam.near = d / 1000
      cam.far = d * 10
      cam.updateProjectionMatrix()
      controls.current?.target.set(0, 0, 0)
      controls.current?.update()
      handle.setRefDist(d)
    }
    api.fit = fit
    fit()
    // One full turn around the target in `steps` frames spread over `ms`; each step goes through controls.update()
    // so damping and the loader's camera-priority path see it exactly like a user drag.
    api.orbit = async (steps = 20, ms = 2000) => {
      const c = controls.current
      if (!c) return
      const cam = camera as THREE.PerspectiveCamera
      const offset = new THREE.Vector3().subVectors(cam.position, c.target)
      const axis = cam.up.clone().normalize()
      for (let i = 1; i <= steps; i++) {
        offset.applyAxisAngle(axis, (2 * Math.PI) / steps)
        cam.position.copy(c.target).add(offset)
        cam.lookAt(c.target)
        c.update()
        await new Promise((r) => setTimeout(r, ms / steps))
      }
    }
    return () => { api.orbit = undefined }
  }, [camera, manifest, handle, api])
  // Throttled camera position to the loader (100 ms) for chunk prioritisation.
  useFrame(() => {
    const now = performance.now()
    if (now - lastSent.current < 100 || !api.sendCamera) return
    lastSent.current = now
    api.sendCamera([camera.position.x, camera.position.y, camera.position.z])
  })
  return <OrbitControls ref={controls} makeDefault enableDamping />
}

// r3f 9.7 `createRoot().configure()` snapshots `state = store.getState()` *before* `await glConfig(...)`, and
// `<Canvas>` re-runs configure() from a dep-less layout effect (twice under StrictMode) before the first async
// factory resolves. The second run therefore sees a stale snapshot with no gl/camera/scene, creates a second
// WebGPURenderer (left at the 300×150 canvas default → depth-stencil size GPUValidationError every frame) and a
// second PerspectiveCamera whose aspect never gets set (store size already matches, so the resize subscriber
// skips updateCamera → NaN projection → black canvas). Make everything configure() creates idempotent: one
// renderer promise per canvas, and stable camera/scene instances owned by <Scene>.
const rendererByCanvas = new WeakMap<HTMLCanvasElement, Promise<THREE.WebGPURenderer>>()
type GlFactoryProps = Parameters<Extract<GLProps, (p: never) => unknown>>[0]   // r3f doesn't export DefaultGLProps

async function createRenderer(props: GlFactoryProps, canvas: HTMLCanvasElement, store: Store<ViewerState>): Promise<THREE.WebGPURenderer> {
  // r3f's default is the WebGL enum ('default' | 'high-performance' | 'low-power'); WebGPU has no 'default'.
  const powerPreference = props.powerPreference as GPUPowerPreference | undefined
  // Same adapter options as WebGPUBackend.init, so the limit requested here is the one three's adapter reports.
  const adapter = await navigator.gpu.requestAdapter({ powerPreference, featureLevel: 'compatibility' })
  if (!adapter) {
    store.set({ status: 'error', error: 'No WebGPU adapter available.' })
    throw new Error('No WebGPU adapter')
  }
  const maxBinding = adapter.limits.maxStorageBufferBindingSize
  const renderer = new THREE.WebGPURenderer({
    ...props,
    canvas,
    powerPreference,
    antialias: false,
    trackTimestamp: true,
    requiredLimits: { maxStorageBufferBindingSize: maxBinding },
  })
  await renderer.init()
  renderer.info.autoReset = false   // Hud owns info.reset()
  const compat = (renderer.backend as unknown as { compatibilityMode: boolean | null }).compatibilityMode
  if (compat) store.set({ status: 'error', error: 'WebGPU compatibility mode not supported (no storage buffers in the vertex stage).' })
  return renderer
}

// Renderer is created once per canvas, but `buffers` changes per dataset (manifestUrl swap keeps <Scene> mounted),
// so the binding-size check must follow the buffers, not the renderer.
function DatasetLimitCheck({ buffers }: { buffers: PointBuffers }) {
  const { gl } = useThree()
  const store = useViewerStore()
  useEffect(() => {
    const maxBinding = (gl as unknown as { backend: { device?: GPUDevice } }).backend.device?.limits.maxStorageBufferBindingSize
    if (maxBinding === undefined) return
    const need = buffers.count * BYTES_PER_POINT
    if (need > maxBinding) store.set({ status: 'error', error: `Dataset too large for this GPU: ${buffers.count.toLocaleString()} points need ${(need / 2 ** 20).toFixed(0)} MiB in one storage binding, limit ${(maxBinding / 2 ** 20).toFixed(0)} MiB.` })
  }, [gl, buffers, store])
  return null
}

export function Scene({ buffers, manifest, handle, editor, api, hudEl, dpr, accent }: {
  buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle; editor: Editor; api: ViewerApi; hudEl: RefObject<HTMLDivElement | null>; dpr?: number; accent: string
}) {
  const store = useViewerStore()
  const camera = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(HOME_FOV, 1, 0.1, 10000)   // aspect set by r3f on the first setSize; CameraRig fits position/near/far
    cam.up.set(0, 0, 1)
    cam.position.copy(HOME_DIR)
    return cam
  }, [])
  const scene = useMemo(() => new THREE.Scene(), [])
  return (
    <Canvas
      style={{ position: 'absolute', inset: 0 }}   // same box as the SVG lasso overlay (root is position: relative)
      camera={camera}
      scene={scene}
      dpr={dpr}
      gl={(props) => {
        const canvas = props.canvas as HTMLCanvasElement
        const cached = rendererByCanvas.get(canvas)
        if (cached) return cached
        const p = createRenderer(props, canvas, store)
        p.catch(() => rendererByCanvas.delete(canvas))
        rendererByCanvas.set(canvas, p)
        return p
      }}
    >
      <DatasetLimitCheck buffers={buffers} />
      <ChunkSprites buffers={buffers} manifest={manifest} handle={handle} accent={accent} />
      <CameraRig manifest={manifest} handle={handle} api={api} />
      <Hud el={hudEl} api={api} />
      <PostPass api={api} />
      <ComputeRunner buffers={buffers} manifest={manifest} api={api} />
      <EditRunner buffers={buffers} manifest={manifest} editor={editor} api={api} />
    </Canvas>
  )
}
