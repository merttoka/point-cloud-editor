import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import type { Bounds } from '../format/quant'
import type { Manifest } from '../loader/manifest'
import type { PointBuffers } from './PointBuffers'
import type { PointMaterialHandle } from './pointMaterial'
import { useStore } from '../state/store'

export function centroidOf(b: Bounds): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
}

export function ChunkSprites({ buffers, manifest, handle, centroid }: {
  buffers: PointBuffers; manifest: Manifest; handle: PointMaterialHandle; centroid: [number, number, number]
}) {
  const sprites = useMemo(() => manifest.chunks.map((c) => {
    const geometry = new THREE.PlaneGeometry(1, 1)      // own geometry: bounds live on it
    const [cx, cy, cz] = centroid
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
    // Sprite.intersectsFrustum ignores geometry bounds; route through the manual sphere (phase 0).
    s.intersectsFrustum = (frustum: THREE.Frustum) => frustum.intersectsObject(s)
    return s
  }), [manifest, handle, centroid])

  const loaded = useStore((s) => s.loaded)
  const budget = useStore((s) => s.budget)
  // Layout effect: r3f's rAF loop runs outside React's paint cycle, so counts must be
  // written synchronously after commit for the change to land in the same frame (spec acceptance).
  useLayoutEffect(() => {
    manifest.chunks.forEach((c, i) => {
      sprites[i].count = buffers.loaded[i] ? Math.ceil(c.count * budget) : 0
    })
  }, [sprites, manifest, buffers, loaded, budget])

  useEffect(() => () => sprites.forEach((s) => s.geometry.dispose()), [sprites])

  return <>{sprites.map((s, i) => <primitive key={i} object={s} />)}</>
}
