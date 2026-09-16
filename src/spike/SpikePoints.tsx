import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { color, float, instanceIndex, select, storage, uniform, uint, vec3 } from 'three/tsl'
import { makeSyntheticCloud } from './synthetic'
import { dequantScale } from '../viewer/format/quant'
import { buildFlagsCompute } from './flagsCompute'

export function SpikePoints({ count, size }: { count: number; size: number }) {
  const points = useMemo(() => {
    const cloud = makeSyntheticCloud(count)
    const b = cloud.bounds

    // Positions: 2 u32 words per point, instanced. Same buffer is read by the flags compute pass.
    const qposAttr = new THREE.StorageInstancedBufferAttribute(cloud.words, 2)
    const qpos = storage(qposAttr, 'uvec2', count)

    // Flags: packed u8 per point in u32 words, written by compute (thread-per-word), read in vertex.
    // No toReadOnly(): setAccess mutates the shared node and would make the compute write fail;
    // WGSLNodeBuilder.getNodeAccess already forces read-only bindings outside the compute stage.
    const fc = buildFlagsCompute(qpos, count)
    const idx = instanceIndex
    const fword = fc.flags.element(idx.shiftRight(uint(2)))
    const fbyte = fword.shiftRight(idx.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xff))
    const isEast = fbyte.bitAnd(uint(1)).notEqual(uint(0))

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
    const base = select(
      cls.equal(uint(6)), color('#e0a040'),
      select(cls.equal(uint(5)), color('#4caf50'), color('#9a9a9a')),
    )
    material.colorNode = select(isEast, color('#ff3b30'), base)

    const pts = new THREE.Sprite(material)
    pts.geometry = geometry
    pts.count = count
    // Sprite.intersectsFrustum uses frustum.intersectsSprite (a unit-radius point at the object
    // origin, ignores geometry bounds). Route it through the manual bounding sphere instead.
    pts.intersectsFrustum = (frustum: THREE.Frustum) => frustum.intersectsObject(pts)
    pts.frustumCulled = true
    ;(pts as any).__spike = { fc, qpos, qposAttr, count, material }
    return pts
  }, [count, size])

  const { gl } = useThree()
  useEffect(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer
    const { fc } = (points as any).__spike as { fc: ReturnType<typeof buildFlagsCompute> }
    ;(window as any).__spikePoints = points
    let cancelled = false
    ;(async () => {
      const hasTs = renderer.hasFeature('timestamp-query')
      const t0 = performance.now()
      await renderer.computeAsync(fc.computeNode)
      const submitMs = performance.now() - t0   // computeAsync does not await GPU completion: encode+submit only
      let gpuMs: number | undefined
      if (hasTs) {
        gpuMs = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)
        if (gpuMs === undefined) gpuMs = renderer.info.compute.timestamp
      }
      if (cancelled) return
      const el = document.getElementById('compute')
      if (el) el.textContent = `flags compute: ${fc.words} words, submit ${submitMs.toFixed(2)} ms, gpu ${gpuMs?.toFixed(3) ?? 'n/a (no timestamp-query)'} ms`
    })()
    return () => { cancelled = true }
  }, [gl, points])

  return <primitive object={points} />
}
