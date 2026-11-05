// Slider arithmetic: step snapping, track geometry, relative drags and which way a touch or scroll is heading.
// Copy of portfolio-web-labs src/components/sliderMath.ts (1b57834). Pure, so it is unit tested (sliderMath.test.ts); the DOM side is Slider.tsx.

/** Digits after the decimal point, so values built from steps print and compare cleanly (0.1 + 0.2 → 0.3). */
export function decimals(n: number): number {
  if (!Number.isFinite(n)) return 0
  const s = String(n)
  const dot = s.indexOf('.')
  const exp = s.indexOf('e-')
  if (exp >= 0) return Number(s.slice(exp + 2)) + (dot >= 0 ? exp - dot - 1 : 0)
  return dot < 0 ? 0 : s.length - dot - 1
}

/** Nearest value on the step grid from min, kept inside [min, max] the way a native range input keeps it. */
export function snap(v: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, v))
  if (!(step > 0)) return clamped
  const places = Math.min(10, Math.max(decimals(step), decimals(min)))
  // The top of the grid, when max itself is off it.
  const top = min + Math.floor((max - min) / step + 1e-9) * step
  const on = min + Math.round((clamped - min) / step) * step
  return Number(Math.min(top, on).toFixed(places))
}

/** Where v sits along the track: 0 at min, 1 at max. */
export function fraction(v: number, min: number, max: number): number {
  return max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0
}

/** Value under clientX `x`, for a track at [left, left + width] whose thumb centre stops `inset` short of each end. */
export function valueAt(x: number, left: number, width: number, inset: number, min: number, max: number): number {
  const span = Math.max(1, width - 2 * inset)
  return min + Math.min(1, Math.max(0, (x - left - inset) / span)) * (max - min)
}

/** Value per pixel of finger travel, so the thumb moves exactly as far as the finger. */
export function perPixel(width: number, inset: number, min: number, max: number): number {
  return (max - min) / Math.max(1, width - 2 * inset)
}

/** Which way a touch set off once it is `slop` px from where it started: 'x' drags the slider, 'y' scrolls the page, null is too early to tell. */
export function heading(dx: number, dy: number, slop: number): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < slop) return null
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
}

/** How far a drag or scroll moves with Shift held. The value stays on the step grid: a step here can be a whole count or an index. */
export const FINE_GAIN = 0.1

/**
 * One move of a relative drag or scroll, on the value before snapping: it follows the pointer's travel, not where the
 * pointer is, so it never jumps. It stops at either end, so reversing moves the thumb at once.
 */
export function dragBy(v: number, dx: number, perPx: number, min: number, max: number, fine = false): number {
  return Math.min(max, Math.max(min, v + dx * perPx * (fine ? FINE_GAIN : 1)))
}

/** Most steps a grid can have and still be marked on the track. */
export const MAX_TICKS = 12

/** Where each stop of a coarse step grid sits along the track; none when the grid is too fine to read. */
export function ticks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !(max > min)) return []
  const n = Math.floor((max - min) / step + 1e-9)
  if (n < 1 || n > MAX_TICKS) return []
  return Array.from({ length: n + 1 }, (_, i) => (i * step) / (max - min))
}

const WHEEL_FULL_RANGE_PX = 2000
const WHEEL_LINE_PX = 40
const WHEEL_PAGE_PX = 800
const WHEEL_SLOP = 6

/** A wheel delta in pixels, from WheelEvent.deltaMode's pixels, lines or pages. */
export function wheelPixels(delta: number, deltaMode: number): number {
  return delta * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1)
}

/** Value per pixel of scroll: negative, as a natural swipe right reports a negative delta and should read as dragging the thumb right. */
export function wheelPerPixel(min: number, max: number): number {
  return -(max - min) / WHEEL_FULL_RANGE_PX
}

/** A wheel gesture so far: which way it set off, and the pixels held back until it said. */
export interface WheelGesture { way: 'x' | 'y' | null; x: number; y: number }

export function newWheelGesture(): WheelGesture {
  return { way: null, x: 0, y: 0 }
}

/**
 * Feeds one wheel event into its gesture. Returns the pixels the slider should travel (0 while it can't yet tell), or
 * null when the event is the page's: a gesture that sets off vertically is the page's for good, however it drifts, so
 * scrolling a panel past a slider can't move it. Alt claims a vertical wheel, for a mouse with no sideways scroll.
 *
 * A gesture too small to tell is held, not left to the page. A trackpad swipe starts with events of a pixel or two, and a
 * browser that sees a gesture's first event go uncancelled stops letting the rest be cancelled: the page would then
 * swipe back, or scroll with the swipe's vertical drift, whatever the slider did.
 */
export function wheelScrub(g: WheelGesture, dx: number, dy: number, alt: boolean): number | null {
  if (g.way === 'y') return null
  g.x += dx
  g.y += dy
  if (g.way === null) {
    g.way = alt ? 'x' : heading(g.x, g.y, WHEEL_SLOP)
    if (g.way === 'y') return null
    if (g.way === null) return 0
  }
  const px = alt && Math.abs(g.y) > Math.abs(g.x) ? g.y : g.x
  g.x = 0
  g.y = 0
  return px
}
