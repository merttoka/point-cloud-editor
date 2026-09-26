import { describe, it, expect } from 'vitest'
import { parseHarnessParams, themeFromMessage } from './harness'

describe('parseHarnessParams', () => {
  it('defaults', () => {
    expect(parseHarnessParams('')).toEqual({ dataset: 'demo', dpr: undefined, bench: false, theme: 'dark' })
  })
  it('validates dataset, clamps dpr, reads bench and theme', () => {
    expect(parseHarnessParams('?data=full&dpr=9&bench=1&theme=light')).toEqual({ dataset: 'full', dpr: 4, bench: true, theme: 'light' })
    expect(parseHarnessParams('?data=../x&dpr=0.1&theme=blue')).toEqual({ dataset: 'demo', dpr: 0.5, bench: false, theme: 'dark' })
  })
})

describe('themeFromMessage', () => {
  it('accepts a same-origin pcv-theme message and rejects everything else', () => {
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'pcv-theme', theme: 'light' } }, 'https://lab.merttoka.com')).toBe('light')
    expect(themeFromMessage({ origin: 'https://evil.example', data: { type: 'pcv-theme', theme: 'light' } }, 'https://lab.merttoka.com')).toBeNull()
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'other' } }, 'https://lab.merttoka.com')).toBeNull()
    expect(themeFromMessage({ origin: 'https://lab.merttoka.com', data: { type: 'pcv-theme', theme: 'neon' } }, 'https://lab.merttoka.com')).toBeNull()
  })
})
