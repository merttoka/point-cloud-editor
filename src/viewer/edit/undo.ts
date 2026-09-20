import type { Range } from './flags'

export interface UndoCommand { min: number; max: number; flags: Uint8Array }
export interface UndoRing {
  push(min: number, max: number): void      // call BEFORE mutating bytes[min..max]
  undo(): Range | null
  redo(): Range | null
  dropLast(): void                          // discard the newest undo command (op turned out to be a no-op)
  undoDepth(): number
  redoDepth(): number
  bytes(): number
  clear(): void
}

const MAX_COMMANDS = 30
const MAX_BYTES = 256 * 2 ** 20

// Each command holds one dense slice; undo/redo swap it with the live bytes, so a command costs the same
// whichever stack it sits on. Whole-buffer edits (lasso, isolate, unhide, clear) cost N bytes each.
export function createUndoRing(live: Uint8Array, opts: { maxCommands?: number; maxBytes?: number } = {}): UndoRing {
  const maxCommands = opts.maxCommands ?? MAX_COMMANDS
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let undo: UndoCommand[] = []
  let redo: UndoCommand[] = []
  let total = 0
  const swap = (c: UndoCommand) => {
    const cur = live.slice(c.min, c.max + 1)
    live.set(c.flags, c.min)
    c.flags = cur
  }
  const evict = () => { while (undo.length > 0 && (undo.length > maxCommands || total > maxBytes)) total -= undo.shift()!.flags.length }
  return {
    push(min, max) {
      for (const c of redo) total -= c.flags.length
      redo = []
      const flags = live.slice(min, max + 1)
      undo.push({ min, max, flags }); total += flags.length
      evict()
    },
    undo() { const c = undo.pop(); if (!c) return null; swap(c); redo.push(c); return { min: c.min, max: c.max } },
    redo() { const c = redo.pop(); if (!c) return null; swap(c); undo.push(c); return { min: c.min, max: c.max } },
    dropLast() { const c = undo.pop(); if (c) total -= c.flags.length },
    undoDepth: () => undo.length,
    redoDepth: () => redo.length,
    bytes: () => total,
    clear() { undo = []; redo = []; total = 0 },
  }
}
