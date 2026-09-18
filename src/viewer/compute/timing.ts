import * as THREE from 'three/webgpu'
import type { ComputeNode } from 'three/webgpu'
import type { PassTiming } from '../state/store'

// submit = CPU encode + submit (computeAsync does not await GPU completion); gpu = timestamp-query delta
// (Metal quantises to ~0.066 ms). Only the resolve result is used — never renderer.info (the HUD resets it).
export async function timedCompute(renderer: THREE.WebGPURenderer, node: ComputeNode, pass: string): Promise<PassTiming> {
  const t0 = performance.now()
  await renderer.computeAsync(node)
  const submitMs = performance.now() - t0
  const gpuMs = renderer.hasFeature('timestamp-query') ? await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE) : null
  return { pass, submitMs, gpuMs: gpuMs ?? null }
}
