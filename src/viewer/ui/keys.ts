export type EditAction = 'lasso' | 'escape' | 'isolate' | 'hide' | 'delete' | 'unhideAll' | 'clearSelection' | 'split' | 'undo' | 'redo' | 'fit' | 'hud'

const LETTERS: Record<string, EditAction> = { l: 'lasso', i: 'isolate', x: 'hide', u: 'unhideAll', c: 'clearSelection', s: 'split', f: 'fit', h: 'hud' }

export function keyAction(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): EditAction | null {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  if (mod) return key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : null
  if (e.key === 'Escape') return 'escape'
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  return LETTERS[key] ?? null
}
