// Dev/production harness helpers (outside src/viewer on purpose: the component parses no URLs).
export type Theme = 'dark' | 'light'
export interface HarnessParams { dataset: string; dpr: number | undefined; bench: boolean; theme: Theme }

const isTheme = (t: unknown): t is Theme => t === 'dark' || t === 'light'

export function parseHarnessParams(search: string): HarnessParams {
  const p = new URLSearchParams(search)
  const data = p.get('data') ?? ''
  const dprRaw = Number(p.get('dpr'))
  const theme = p.get('theme')
  return {
    dataset: /^[a-z0-9-]+$/.test(data) ? data : 'demo',
    dpr: Number.isFinite(dprRaw) && dprRaw > 0 ? Math.min(4, Math.max(0.5, dprRaw)) : undefined,
    bench: p.get('bench') === '1',
    theme: isTheme(theme) ? theme : 'dark',
  }
}

// The Lab page posts { type: 'pcv-theme', theme } into the iframe; only its own origin (the proxy makes them equal) counts.
export function themeFromMessage(ev: { origin: string; data: unknown }, ownOrigin: string): Theme | null {
  if (ev.origin !== ownOrigin) return null
  const d = ev.data as { type?: unknown; theme?: unknown } | null
  return d && d.type === 'pcv-theme' && isTheme(d.theme) ? d.theme : null
}
