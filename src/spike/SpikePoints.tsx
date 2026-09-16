import { useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { color, float, instanceIndex, select, storage, uniform, uint, vec3 } from 'three/tsl'
import { makeSyntheticCloud } from './synthetic'
import { dequantScale } from '../viewer/format/quant'

export function SpikePoints({ count, size }: { count: number; size: number }) {
  const points = useMemo(() => {
    const cloud = makeSyntheticCloud(count)
    const b = cloud.bounds

    // Positions: 2 u32 words per point, instanced. Same buffer is readable by compute (Task 4).
    const qposAttr = new THREE.StorageInstancedBufferAttribute(cloud.words, 2)
    const qpos = storage(qposAttr, 'uvec2', count)

    // Path B (brief Step 6): WebGPU point-list is fixed 1px, so draw one billboard quad
    // per instance (Sprite + instancing); instanceIndex == point index.
    const geometry = new THREE.PlaneGeometry(1, 1)
    geometry.setAttribute('qpos', qposAttr)

    // Three cannot derive bounds from qpos; set manually so frustum culling works.
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))
    geometry.boundingBox = box
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere())

    const dqMin = uniform(new THREE.Vector3(...b.min))
    const dqScale = uniform(new THREE.Vector3(...dequantScale(b)))

    const w = qpos.toAttribute()                       // uvec2 per instance
    const x = w.x.bitAnd(uint(0xffff))
    const y = w.x.shiftRight(uint(16))
    const z = w.y.bitAnd(uint(0xffff))
    const cls = w.y.shiftRight(uint(24)).bitAnd(uint(0xff))

    // PointsNodeMaterial on a Sprite: sizeNode is honoured in px (setupVertexSprite),
    // unlike SpriteNodeMaterial.scaleNode which is world units × depth when sizeAttenuation=false.
    const material = new THREE.PointsNodeMaterial()
    material.positionNode = vec3(x, y, z).mul(dqScale).add(dqMin)
    material.sizeNode = float(size)
    material.sizeAttenuation = false
    material.colorNode = select(
      cls.equal(uint(6)), color('#e0a040'),
      select(cls.equal(uint(5)), color('#4caf50'), color('#9a9a9a')),
    )

    const pts = new THREE.Sprite(material)
    pts.geometry = geometry
    pts.count = count
    // Sprite.intersectsFrustum uses frustum.intersectsSprite (a unit-radius point at the object
    // origin, ignores geometry bounds). Route it through the manual bounding sphere instead.
    pts.intersectsFrustum = (frustum: THREE.Frustum) => frustum.intersectsObject(pts)
    pts.frustumCulled = true
    // Expose for Task 4
    ;(pts as any).__spike = { qpos, qposAttr, count, material, cls, instanceIndex }
    return pts
  }, [count, size])

  return <primitive object={points} />
}
