import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { centroidOf, type Manifest } from '../loader/manifest'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import { useStore, useViewerStore } from '../state/store'

export function ChunkSprites({ buffers, manifest, handle, accent }: { buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle; accent: string }) {
  const store = useViewerStore()
  const sprites = useMemo(() => {
    const [cx, cy, cz] = centroidOf(manifest.bounds)
    return manifest.chunks.map((c) => {
      const geometry = new THREE.PlaneGeometry(1, 1)      // own geometry: bounds live on it
      const box = new THREE.Box3(
        new THREE.Vector3(c.bounds.min[0] - cx, c.bounds.min[1] - cy, c.bounds.min[2] - cz),
        new THREE.Vector3(c.bounds.max[0] - cx, c.bounds.max[1] - cy, c.bounds.max[2] - cz),
      )
      geometry.boundingBox = box
      geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
      const s = new THREE.Sprite(handle.material)
      s.geometry = geometry
      s.count = 0
      s.userData.chunkBase = c.offset
      // Sprite.intersectsFrustum tests a unit sphere at the origin, not geometry bounds; route through the manual sphere.
      s.intersectsFrustum = (frustum: THREE.Frustum) => frustum.intersectsObject(s)
      return s
    })
  }, [manifest, handle])

  // Counts are written straight onto the sprites inside the store notification, so a chunk is visible in the
  // same frame it lands and no React render happens per chunk. The loader marks buffers.loaded[i] before it publishes.
  useEffect(() => {
    const apply = () => {
      const { budget } = store.get()
      manifest.chunks.forEach((c, i) => { sprites[i].count = buffers.loaded[i] ? Math.ceil(c.count * budget) : 0 })
    }
    apply()
    return store.subscribe(apply)
  }, [sprites, manifest, buffers, store])

  const pointSize = useStore((s) => s.pointSize)
  const colorMode = useStore((s) => s.colorMode)
  const colormap = useStore((s) => s.colormap)
  const shading = useStore((s) => s.shading)
  useEffect(() => { handle.setPointSize(pointSize) }, [handle, pointSize])
  useEffect(() => { handle.setShading(shading) }, [handle, shading])
  useEffect(() => { if (accent) handle.setHighlight(accent) }, [handle, accent])
  useEffect(() => {
    handle.setMode(colorMode)
    handle.setLut(colorMode === 'class' ? 'class' : colormap)
  }, [handle, colorMode, colormap])

  useEffect(() => () => sprites.forEach((s) => s.geometry.dispose()), [sprites])

  return <>{sprites.map((s, i) => <primitive key={i} object={s} />)}</>
}
