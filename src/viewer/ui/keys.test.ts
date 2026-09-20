import { describe, it, expect } from 'vitest'
import { keyAction } from './keys'

const k = (key: string, extra: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
  keyAction({ key, code: extra.code ?? '', metaKey: false, ctrlKey: false, shiftKey: false, ...extra })
describe('keyAction', () => {
  it('maps editing keys (H stays HUD, X hides)', () => {
    expect(k('l')).toBe('lasso'); expect(k('Escape')).toBe('escape'); expect(k('i')).toBe('isolate'); expect(k('X')).toBe('hide')
    expect(k('Delete')).toBe('delete'); expect(k('Backspace')).toBe('delete'); expect(k('u')).toBe('unhideAll')
    expect(k('c')).toBe('clearSelection'); expect(k('s')).toBe('split'); expect(k('f')).toBe('fit'); expect(k('h')).toBe('hud')
  })
  it('undo / redo need meta or ctrl; shift flips to redo', () => {
    expect(k('z')).toBeNull()
    expect(k('z', { metaKey: true })).toBe('undo'); expect(k('z', { ctrlKey: true })).toBe('undo')
    expect(k('z', { metaKey: true, shiftKey: true })).toBe('redo'); expect(k('Z', { ctrlKey: true, shiftKey: true })).toBe('redo')
  })
  it('modified letters are not actions', () => { expect(k('i', { metaKey: true })).toBeNull() })
})
