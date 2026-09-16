export function spikeParams(): { n: number; size: number } {
  const q = new URLSearchParams(window.location.search)
  const n = Math.max(1, Math.min(30_000_000, Number(q.get('n') ?? 2_000_000)))
  const size = Math.max(1, Math.min(32, Number(q.get('size') ?? 3)))
  return { n, size }
}
