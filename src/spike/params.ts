export function spikeParams(): { n: number; size: number } {
  const q = new URLSearchParams(window.location.search)
  const nRaw = Number(q.get('n'))
  const n = Math.max(1, Math.min(30_000_000, Number.isFinite(nRaw) ? nRaw : 2_000_000))
  const sizeRaw = Number(q.get('size'))
  const size = Math.max(1, Math.min(32, Number.isFinite(sizeRaw) ? sizeRaw : 3))
  return { n, size }
}
