import { useEffect, useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from '../render/PointBuffers'
import { homePose, type ViewerApi } from '../render/Scene'
import { patchEdit, useStore, useViewerStore } from '../state/store'
import type { Editor } from './editor'
import { createSelectPipeline, type ViewParams } from './selectPipeline'
import { packPoly } from './lasso'

// Inside <Canvas>: owns the GPU select pipeline, exposes api.pick/api.lasso, disables OrbitControls in lasso mode.
export function EditRunner({ buffers, manifest, editor, api }: { buffers: PointBuffers; manifest: Manifest; editor: Editor; api: ViewerApi }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null
  const store = useViewerStore()
  const tool = useStore((s) => s.edit.tool)

  useEffect(() => { if (controls) controls.enabled = tool === 'orbit' }, [controls, tool])

  useLayoutEffect(() => {
    const p = createSelectPipeline(gl as unknown as THREE.WebGPURenderer, buffers, manifest)
    const canvas = (gl as unknown as THREE.WebGPURenderer).domElement
    const viewProj = new THREE.Matrix4(), view = new THREE.Matrix4()   // scratch; the pipeline copies them per call
    const params = (): ViewParams => {
      camera.updateMatrixWorld()
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      view.copy(camera.matrixWorldInverse)
      return { viewProj, view, width: canvas.clientWidth, height: canvas.clientHeight,
        pointSize: store.get().pointSize, refDist: homePose(manifest, camera.fov).dist, budget: store.get().budget }
    }
    const patch = (e: Parameters<typeof patchEdit>[1]) => patchEdit(store, e)
    api.viewParams = params   // the bench CPU reference projects with the same matrices
    api.pick = async (x, y, mode) => {
      if (!editor.ready()) return
      patch({ busy: true })
      try { const r = await p.pick(x, y, params()); patch({ busy: false, pickMs: r.ms }); editor.pick(r.index, mode) }
      catch (err) { patch({ busy: false, message: String(err) }) }
    }
    api.lasso = async (polyPx, mode) => {
      if (!editor.ready()) return
      const { data, count } = packPoly(polyPx)
      if (count < 3) return
      editor.beginGpuEdit()
      try {
        const { gpuMs, readbackMs } = await p.lasso(data, count, mode, params())
        editor.endGpuEdit()
        patch({ lasso: { gpuMs, readbackMs } })
      } catch (err) { editor.abortGpuEdit(); patch({ message: String(err) }) }
    }
    return () => { api.pick = undefined; api.lasso = undefined; api.viewParams = undefined; p.dispose() }
  }, [gl, camera, buffers, manifest, editor, api, store])
  return null
}
