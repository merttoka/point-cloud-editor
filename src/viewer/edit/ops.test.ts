import { describe, it, expect } from 'vitest'
import { FLAG_SELECTED as S, FLAG_HIDDEN as H, FLAG_DELETED as D, FLAG_SPLIT_A as A, FLAG_SPLIT_B as B } from './flags'
import { isolate, hide, del, unhideAll, clearSelection, applyPick, tagSplit } from './ops'

const mk = (...v: number[]) => new Uint8Array(v)

describe('ops', () => {
  it('isolate hides non-selected, keeps deleted untouched, returns the touched range', () => {
    const b = mk(0, S, 0, D, 0)
    expect(isolate(b, 'all')).toEqual({ min: 0, max: 4 })
    expect(Array.from(b)).toEqual([H, S, H, D, H])
  })
  it('hide / delete take selected (with side filter) and clear selection + split bits', () => {
    const b = mk(S | A, S | B, S, 0)
    expect(hide(b, 'A')).toEqual({ min: 0, max: 0 })
    expect(Array.from(b)).toEqual([H, S | B, S, 0])
    expect(del(b, 'all')).toEqual({ min: 1, max: 2 })
    expect(Array.from(b)).toEqual([H, D, D, 0])
    expect(del(b, 'all')).toBeNull()
  })
  it('unhideAll and clearSelection', () => {
    const b = mk(H, H | S, S | A, D)
    expect(unhideAll(b)).toEqual({ min: 0, max: 1 })
    expect(Array.from(b)).toEqual([0, S, S | A, D])
    expect(clearSelection(b, { min: 1, max: 2 })).toEqual({ min: 1, max: 2 })
    expect(Array.from(b)).toEqual([0, 0, 0, D])
    expect(clearSelection(b, null)).toBeNull()
  })
  it('applyPick modes', () => {
    const b = mk(0, S, 0, 0)
    expect(applyPick(b, 3, 'add', { min: 1, max: 1 })).toEqual({ min: 3, max: 3 })
    expect(applyPick(b, 0, 'replace', { min: 1, max: 3 })).toEqual({ min: 0, max: 1 })   // only bytes 0..1 actually changed
    expect(Array.from(b)).toEqual([S, 0, 0, 0])
    expect(applyPick(b, 0, 'subtract', { min: 0, max: 0 })).toEqual({ min: 0, max: 0 })
    expect(Array.from(b)).toEqual([0, 0, 0, 0])
  })
  it('tagSplit tags selected points by side predicate', () => {
    const b = mk(S, S | B, 0, S)
    expect(tagSplit(b, (i) => i < 2)).toEqual({ min: 0, max: 3 })
    expect(Array.from(b)).toEqual([S | A, S | A, 0, S | B])
  })
})
