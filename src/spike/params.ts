function param(q: URLSearchParams, key: string, fallback: number, max: number): number {
  const v = Number(q.get(key) || NaN)   // missing/empty → NaN → fallback (Number(null) is 0)
  return Math.max(1, Math.min(max, Math.floor(Number.isFinite(v) ? v : fallback)))
}

export function spikeParams(): { n: number; size: number } {
  const q = new URLSearchParams(window.location.search)
  return { n: param(q, 'n', 2_000_000, 30_000_000), size: param(q, 'size', 3, 32) }
}
