import { describe, expect, it } from 'vitest'
import { decimals, dragBy, FINE_GAIN, fraction, heading, MAX_TICKS, newWheelGesture, perPixel, snap, ticks, valueAt, wheelPerPixel, wheelPixels, wheelScrub } from './sliderMath'

describe('decimals', () => {
  it('counts digits after the point, including exponent forms', () => {
    expect(decimals(1)).toBe(0)
    expect(decimals(500)).toBe(0)
    expect(decimals(0.05)).toBe(2)
    expect(decimals(0.001)).toBe(3)
    expect(decimals(1e-7)).toBe(7)
    expect(decimals(1.5e-7)).toBe(8)
  })
})

describe('snap', () => {
  it('rounds to the step grid counted from min', () => {
    expect(snap(37.6, -180, 180, 1)).toBe(38)
    expect(snap(1730, 500, 4_000_000, 500)).toBe(1500)
    expect(snap(0.12, 0.05, 3, 0.05)).toBe(0.1)
  })
  it('cleans float noise from the grid', () => {
    expect(snap(0.5 + 475 * 0.001, 0.5, 0.999, 0.001)).toBe(0.975)
    expect(snap(0.30000000000000004, 0, 1, 0.1)).toBe(0.3)
  })
  it('clamps to the range, stopping at the top of the grid when max is off it', () => {
    expect(snap(-5, 0, 10, 1)).toBe(0)
    expect(snap(99, 0, 10, 1)).toBe(10)
    expect(snap(10, 0, 10, 3)).toBe(9)
  })
  it('only clamps without a usable step', () => {
    expect(snap(0.123, 0, 1, 0)).toBe(0.123)
  })
})

describe('fraction', () => {
  it('maps min..max to 0..1 and clamps', () => {
    expect(fraction(15, 0, 90)).toBeCloseTo(1 / 6)
    expect(fraction(-1, 0, 90)).toBe(0)
    expect(fraction(100, 0, 90)).toBe(1)
    expect(fraction(3, 3, 3)).toBe(0)
  })
})

describe('valueAt', () => {
  // A 216px track at x = 100 whose thumb centre travels from 108 to 308.
  it('puts min and max where the thumb centre stops', () => {
    expect(valueAt(108, 100, 216, 8, 0, 10)).toBe(0)
    expect(valueAt(308, 100, 216, 8, 0, 10)).toBe(10)
    expect(valueAt(208, 100, 216, 8, 0, 10)).toBe(5)
  })
  it('clamps outside the track', () => {
    expect(valueAt(0, 100, 216, 8, 0, 10)).toBe(0)
    expect(valueAt(1000, 100, 216, 8, 0, 10)).toBe(10)
  })
})

describe('heading', () => {
  it('waits until the touch is past the slop', () => {
    expect(heading(3, 2, 6)).toBe(null)
  })
  it('drags for a sideways start and scrolls for a vertical one', () => {
    expect(heading(7, 3, 6)).toBe('x')
    expect(heading(-7, 3, 6)).toBe('x')
    expect(heading(2, -8, 6)).toBe('y')
    expect(heading(5, 5, 6)).toBe('y')
  })
})

describe('dragBy', () => {
  const perPx = perPixel(216, 8, 0, 100) // 0.5 per px
  it('moves the value as far as the pointer moved', () => {
    expect(perPx).toBe(0.5)
    expect(dragBy(40, 20, perPx, 0, 100)).toBe(50)
    expect(dragBy(40, -20, perPx, 0, 100)).toBe(30)
  })
  it('stops at the ends, so reversing moves the thumb straight away', () => {
    const over = dragBy(90, 100, perPx, 0, 100)
    expect(over).toBe(100)
    expect(dragBy(over, -10, perPx, 0, 100)).toBe(95)
    expect(dragBy(10, -50, perPx, 0, 100)).toBe(0)
  })
  it('moves a tenth as far when fine', () => {
    expect(FINE_GAIN).toBe(0.1)
    expect(dragBy(40, 20, perPx, 0, 100, true)).toBe(41)
  })
})

describe('ticks', () => {
  it('marks each stop of a coarse grid, as fractions of the range', () => {
    expect(ticks(1, 5, 1)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })
  it('stops at the top of the grid when max is off it', () => {
    expect(ticks(0, 10, 4)).toEqual([0, 0.4, 0.8])
  })
  it('marks nothing on a grid too fine to read', () => {
    expect(ticks(0, 1, 0.01)).toEqual([])
    expect(ticks(0, MAX_TICKS + 1, 1)).toEqual([])
    expect(ticks(0, MAX_TICKS, 1)).toHaveLength(MAX_TICKS + 1)
  })
  it('marks nothing without a range or a step', () => {
    expect(ticks(0, 0, 1)).toEqual([])
    expect(ticks(0, 1, 0)).toEqual([])
  })
})

describe('wheelPixels', () => {
  it('passes pixels through, and turns lines and pages into pixels', () => {
    expect(wheelPixels(12, 0)).toBe(12)
    expect(wheelPixels(3, 1)).toBe(120)
    expect(wheelPixels(1, 2)).toBe(800)
  })
})

describe('wheelPerPixel', () => {
  it('raises the value for a natural swipe right, which reports a negative delta', () => {
    expect(dragBy(50, -200, wheelPerPixel(0, 100), 0, 100)).toBeGreaterThan(50)
    expect(dragBy(50, 200, wheelPerPixel(0, 100), 0, 100)).toBeLessThan(50)
  })
  it('crosses a range in the same distance whatever its size', () => {
    expect(wheelPerPixel(0, 1000) / wheelPerPixel(0, 10)).toBe(100)
  })
})

describe('wheelScrub', () => {
  it('steers from the first event of a sideways swipe', () => {
    expect(wheelScrub(newWheelGesture(), -40, 2, false)).toBe(-40)
  })
  it('leaves a vertical scroll to the page, even when it drifts sideways later', () => {
    const g = newWheelGesture()
    expect(wheelScrub(g, 0, 40, false)).toBe(null)
    expect(wheelScrub(g, 60, 2, false)).toBe(null)
    expect(wheelScrub(g, 60, 0, false)).toBe(null)
  })
  it('waits while a gesture is too small to tell, then applies what it held back', () => {
    const g = newWheelGesture()
    expect(wheelScrub(g, -1, 1, false)).toBe(null)
    expect(wheelScrub(g, -5, 1, false)).toBe(-6)
    expect(wheelScrub(g, -3, 0, false)).toBe(-3)
  })
  it('ignores vertical drift once steering', () => {
    const g = newWheelGesture()
    wheelScrub(g, -40, 0, false)
    expect(wheelScrub(g, -1, 50, false)).toBe(-1)
  })
  it('steers from a vertical wheel with Alt held', () => {
    expect(wheelScrub(newWheelGesture(), 0, -100, true)).toBe(-100)
  })
})
