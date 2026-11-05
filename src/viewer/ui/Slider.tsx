// Copy of portfolio-web-labs src/components/Slider.tsx (ca4af8b), on a CSS module: keep the two in step by hand.
import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { dragBy, fraction, heading, newWheelGesture, perPixel, snap, ticks, valueAt, wheelPerPixel, wheelPixels, wheelScrub, type WheelGesture } from './sliderMath'
import styles from './Slider.module.css'

interface Props {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Names the steppers ("increase speed"); the input itself takes its name from a `<label htmlFor={id}>`. */
  label: string;
  /** The formatted value, read out by screen readers ("15°"). */
  valueText: string;
  onChange: (v: number) => void;
  /** How far a stepper tap or arrow key moves (default one step): a step finer than the value shown would look like it did nothing. */
  nudge?: number;
  disabled?: boolean;
}

// A touch further than this from where it started has a direction: sideways drags the slider, anything else scrolls.
const SLOP = 6
const HOLD_MS = 400
const REPEAT_MS = 70
// After this many repeats a held stepper moves ten steps a tick.
const FAST_AFTER = 20
// A scroll this long after the last event is a new gesture, free to set off another way.
const WHEEL_IDLE_MS = 350
// The ghost shows where a drag is between two steps, once it is this far from the thumb.
const GHOST_MIN_PX = 2

// The thumb centre stops half a thumb from each end of the track (--pcv-slider-thumb in Slider.module.css).
const insetOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).getPropertyValue('--pcv-slider-thumb')) / 2 || 7

/**
 * The lab's range control. A hidden native range input keeps keyboard and screen-reader support; the visible track takes
 * pointer input.
 *
 * Mouse and pen: click the track to jump, drag the thumb without it jumping; a drag follows the pointer's travel, and
 * Shift moves it a tenth as far. Scrolling sideways over the track moves the value (Alt lets a vertical wheel do it,
 * Shift is fine again); scrolling vertically stays the page's. Touch: a touch that sets off sideways locks the slider
 * until the finger lifts, wherever the finger then wanders up or down, and moves the value by as far as the finger
 * travels; a touch that sets off vertically is left to the page as a scroll. On touch screens − / + steppers either side
 * nudge one step, and repeat while held.
 *
 * The value always lands on the step grid. On a coarse grid, the ghost shows where the pointer has got to between stops.
 */
export default function Slider({ id, value, min, max, step, label, valueText, onChange, nudge: nudgeBy, disabled = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Latest props for the native listeners and timers, which outlive a render.
  const live = useRef({ value, min, max, step, onChange, nudgeBy, disabled })
  live.current = { value, min, max, step, onChange, nudgeBy, disabled }
  // Last value sent up, so repeated moves before the next render compare against what was sent, not a stale prop.
  const sent = useRef(value)
  sent.current = value

  const send = (v: number) => {
    if (v === sent.current) return
    sent.current = v
    live.current.onChange(v)
  }

  // Set on the element, not in state: most moves on a coarse grid change only this, and need no render.
  const steer = (raw: number) => {
    const { min, max, step } = live.current
    const v = snap(raw, min, max, step)
    const el = rootRef.current
    if (el) {
      const off = Math.abs(fraction(raw, min, max) - fraction(v, min, max)) * el.clientWidth >= GHOST_MIN_PX
      el.classList.toggle(styles.hasGhost, off)
      if (off) el.style.setProperty('--g', String(fraction(raw, min, max)))
    }
    send(v)
  }
  const settle = () => rootRef.current?.classList.remove(styles.hasGhost, styles.dragging)

  // Touch goes through touch events: they stay with the slider wherever the finger moves, and cancelling them is what
  // keeps the page from scrolling once a drag is under way.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let touch: { id: number; x0: number; y0: number; x: number; raw: number; perPx: number; dragging: boolean } | null = null
    const find = (list: TouchList, tid: number) => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === tid) return list[i]
      return null
    }
    const onStart = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      // One finger at a time; a stylus is handled as a pen by the pointer handlers.
      if (live.current.disabled || touch || !t || (t as Touch & { touchType?: string }).touchType === 'stylus') return
      const { value, min, max } = live.current
      touch = {
        id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, raw: value,
        perPx: perPixel(el.getBoundingClientRect().width, insetOf(el), min, max),
        dragging: false,
      }
    }
    const onMove = (e: TouchEvent) => {
      if (!touch) return
      const t = find(e.changedTouches, touch.id)
      if (!t) return
      if (!touch.dragging) {
        const way = heading(t.clientX - touch.x0, t.clientY - touch.y0, SLOP)
        if (way === null) return
        if (way === 'y') { touch = null; return }
        touch.dragging = true
        el.classList.add(styles.dragging)
      }
      if (e.cancelable) e.preventDefault()
      const { min, max } = live.current
      touch.raw = dragBy(touch.raw, t.clientX - touch.x, touch.perPx, min, max)
      touch.x = t.clientX
      steer(touch.raw)
    }
    const onEnd = (e: TouchEvent) => {
      if (!touch || !find(e.changedTouches, touch.id)) return
      touch = null
      settle()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  // A native listener: React's onWheel is passive, and a swipe that moves the slider must not also swipe the page back.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let gesture: (WheelGesture & { raw: number }) | null = null
    let idle = 0
    const onWheel = (e: WheelEvent) => {
      // deltaMode before the deltas: Firefox reports lines only to a page that asks first.
      const mode = e.deltaMode
      const { value, min, max, disabled } = live.current
      // With Ctrl or ⌘ it's a pinch or the browser's zoom.
      if (disabled || e.ctrlKey || e.metaKey) return
      window.clearTimeout(idle)
      idle = window.setTimeout(() => { gesture = null; settle() }, WHEEL_IDLE_MS)
      gesture ??= { ...newWheelGesture(), raw: value }
      const px = wheelScrub(gesture, wheelPixels(e.deltaX, mode), wheelPixels(e.deltaY, mode), e.altKey)
      if (px === null) return
      if (e.cancelable) e.preventDefault()
      gesture.raw = dragBy(gesture.raw, px, wheelPerPixel(min, max), min, max, e.shiftKey)
      steer(gesture.raw)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.clearTimeout(idle)
    }
  }, [])

  // Mouse and pen: a captured drag, relative to where it started, so Shift can slow it mid-drag.
  const drag = useRef<{ id: number; x: number; raw: number; perPx: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.pointerType === 'touch' || e.button !== 0) return
    const el = e.currentTarget
    e.preventDefault() // no text selection; focus goes to the input instead, so the arrow keys work after a click
    inputRef.current?.focus({ preventScroll: true })
    const inset = insetOf(el)
    const r = el.getBoundingClientRect()
    const thumbX = r.left + inset + fraction(value, min, max) * (r.width - 2 * inset)
    // On the thumb it stays put until the pointer moves. On the track it jumps to the pointer.
    const onThumb = Math.abs(e.clientX - thumbX) <= inset
    const raw = onThumb ? value : valueAt(e.clientX, r.left, r.width, inset, min, max)
    el.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, raw, perPx: perPixel(r.width, inset, min, max) }
    el.classList.add(styles.dragging)
    if (!onThumb) steer(raw)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (d?.id !== e.pointerId) return
    d.raw = dragBy(d.raw, e.clientX - d.x, d.perPx, min, max, e.shiftKey)
    d.x = e.clientX
    steer(d.raw)
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    settle()
  }

  // Steppers: a tap is one step (on click, so a tap that becomes a scroll does nothing); holding repeats.
  const hold = useRef<{ timer: number; repeat: number; ticks: number } | null>(null)
  const swallowClick = useRef(false)
  const nudge = (dir: number, steps = 1) => {
    const { min, max, step, nudgeBy } = live.current
    send(snap(sent.current + dir * (nudgeBy ?? step) * steps, min, max, step))
  }
  /** Ends a hold; true when it had started repeating. */
  const stopHold = () => {
    const h = hold.current
    if (!h) return false
    clearTimeout(h.timer)
    clearInterval(h.repeat)
    hold.current = null
    return h.ticks > 0
  }
  // Released on the button after repeating: the click that follows would add one more step.
  const releaseHold = () => { if (stopHold()) swallowClick.current = true }
  const startHold = (dir: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    stopHold()
    swallowClick.current = false
    const h = { timer: 0, repeat: 0, ticks: 0 }
    hold.current = h
    h.timer = window.setTimeout(() => {
      const tick = () => { h.ticks++; nudge(dir, h.ticks > FAST_AFTER ? 10 : 1) }
      tick()
      h.repeat = window.setInterval(tick, REPEAT_MS)
    }, HOLD_MS)
  }
  const click = (dir: number) => () => {
    if (swallowClick.current) { swallowClick.current = false; return }
    nudge(dir)
  }
  useEffect(() => () => { stopHold() }, [])

  const stepper = (dir: number, glyph: string, name: string) => (
    <button
      type="button"
      className={styles.step}
      aria-label={`${name} ${label}`}
      disabled={disabled}
      onClick={click(dir)}
      onPointerDown={startHold(dir)}
      onPointerUp={releaseHold}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  )

  const f = fraction(value, min, max)
  const stops = ticks(min, max, step)
  return (
    <div className={disabled ? `${styles.slider} ${styles.disabled}` : styles.slider}>
      {stepper(-1, '−', 'decrease')}
      <div
        ref={rootRef}
        className={styles.rail}
        style={{ '--f': f } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <input
          ref={inputRef}
          id={id}
          type="range"
          className={styles.input}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={valueText}
          onChange={(e) => send(Number(e.target.value))}
          onKeyDown={(e) => {
            // The arrows move a shown step (the steppers' `nudge`), not one finer than the readout shows (a screen reader
            // would hear the same value press after press). Shift keeps the finer one to hand.
            const { min, max, step, nudgeBy } = live.current
            if (!nudgeBy || nudgeBy <= step) return
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
            const page = e.key === 'PageUp' ? 1 : e.key === 'PageDown' ? -1 : 0
            if (!dir && !page) return
            e.preventDefault()
            if (dir && e.shiftKey) send(snap(sent.current + dir * step, min, max, step))
            else nudge(dir || page, page ? 10 : 1)
          }}
        />
        <span className={styles.track} aria-hidden="true"><span className={styles.fill} /></span>
        {stops.map((t) => (
          <span key={t} className={t <= f ? `${styles.tick} ${styles.passed}` : styles.tick} style={{ '--t': t } as CSSProperties} aria-hidden="true" />
        ))}
        <span className={styles.ghost} aria-hidden="true" />
        <span className={styles.thumb} aria-hidden="true" />
      </div>
      {stepper(1, '+', 'increase')}
    </div>
  )
}
