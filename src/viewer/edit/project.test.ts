import { describe, it, expect } from 'vitest'
import { projectPoint, cpuPick, decodeWorld } from './project'
import { packWords } from '../format/quant'

// Column-major perspective (WebGPU depth 0..1): fov 90°, aspect 1, near 1, far 100.
function persp(): number[] {
  const n = 1, f = 100
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, f / (n - f), -1, 0, 0, (n * f) / (n - f), 0]
}
describe('projectPoint', () => {
  it('maps the view axis to the viewport centre with depth in [0,1]', () => {
    const r = projectPoint(0, 0, -10, persp(), 800, 600)!
    expect(r[0]).toBeCloseTo(400); expect(r[1]).toBeCloseTo(300)
    expect(r[2]).toBeGreaterThan(0); expect(r[2]).toBeLessThan(1)
  })
  it('y up in NDC is y down on screen; behind camera is null', () => {
    const r = projectPoint(0, 5, -10, persp(), 800, 600)!
    expect(r[1]).toBeLessThan(300)
    expect(projectPoint(0, 0, 10, persp(), 800, 600)).toBeNull()
  })
})
describe('cpuPick', () => {
  it('returns the nearest-depth point within radius, honouring visibility', () => {
    // three points on the view axis at z = -10, -20, -30 (q values chosen with dqScale 1, dqMin 0 → world = q)
    const words = new Uint32Array(6)
    const put = (i: number, z: number) => { const [a, b] = packWords(0, 0, z, 0); words[i * 2] = a; words[i * 2 + 1] = b }
    put(0, 30); put(1, 10); put(2, 20)
    const dq: [number, number, number] = [1, 1, 1], mn: [number, number, number] = [0, 0, -40]   // world z = q - 40 → -10, -30, -20
    const vp = persp()
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 400, 300, () => true, () => 3)).toBe(0)      // z = -10 is nearest
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 400, 300, (i) => i !== 0, () => 3)).toBe(2)   // then z = -20
    expect(cpuPick(words, 3, dq, mn, vp, 800, 600, 700, 300, () => true, () => 3)).toBeNull()
    expect(decodeWorld(words, 0, dq, mn)).toEqual([0, 0, -10])
  })
})
