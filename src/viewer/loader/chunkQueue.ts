export interface ChunkRef {
  index: number
  offset: number
  count: number
  centre: [number, number, number]
}

export class ChunkQueue {
  private items: ChunkRef[]
  private cam: [number, number, number] = [0, 0, 0]
  private dirty = true

  constructor(chunks: ChunkRef[]) {
    this.items = chunks.slice()
  }

  setCamera(pos: [number, number, number]): void {
    this.cam = pos
    this.dirty = true
  }

  get size(): number { return this.items.length }

  pop(): ChunkRef | undefined {
    if (this.dirty) {
      const [cx, cy, cz] = this.cam
      const d2 = (c: ChunkRef) => (c.centre[0] - cx) ** 2 + (c.centre[1] - cy) ** 2 + (c.centre[2] - cz) ** 2
      this.items.sort((a, b) => d2(b) - d2(a))   // farthest first so pop() from the end is nearest
      this.dirty = false
    }
    return this.items.pop()
  }
}
