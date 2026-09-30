import { BYTES_PER_POINT, type Bounds } from '../format/quant'

export function centroidOf(b: Bounds): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
}

export interface ManifestChunk { offset: number; count: number; bounds: Bounds }

export interface SegmentMeta { id: number; name: string; color: string }   // one exported/imported segment row (#rrggbb)

export interface Manifest {
  version: 1
  name: string
  source?: string
  license?: string
  crs?: string
  units: 'm'
  bounds: Bounds
  pointCount: number
  bytesPerPoint: typeof BYTES_PER_POINT
  file: string
  classMap: Record<string, string>
  chunks: ManifestChunk[]
  segments?: SegmentMeta[]     // phase 7 export: user segments (ids 1..255), optional
  segmentsFile?: string        // one byte per point, same order as `file`; optional
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}
function isBounds(b: unknown): b is Bounds {
  return typeof b === 'object' && b !== null && isVec3((b as Bounds).min) && isVec3((b as Bounds).max)
}

export function validateManifest(json: unknown): Manifest {
  if (typeof json !== 'object' || json === null) throw new Error('manifest: not an object')
  const m = json as Record<string, unknown>
  if (m.version !== 1) throw new Error(`manifest: unsupported version ${String(m.version)}`)
  if (m.bytesPerPoint !== BYTES_PER_POINT) throw new Error(`manifest: bytesPerPoint must be ${BYTES_PER_POINT}, got ${String(m.bytesPerPoint)}`)
  if (typeof m.file !== 'string') throw new Error('manifest: file missing')
  if (typeof m.pointCount !== 'number') throw new Error('manifest: pointCount missing')
  if (!isBounds(m.bounds)) throw new Error('manifest: bounds invalid')
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) throw new Error('manifest: chunks missing')
  let next = 0
  for (const c of m.chunks as ManifestChunk[]) {
    if (typeof c.offset !== 'number' || typeof c.count !== 'number' || !isBounds(c.bounds)) throw new Error('manifest: chunk invalid')
    if (c.offset !== next) throw new Error(`manifest: chunks not contiguous at offset ${c.offset}, expected ${next}`)
    next += c.count
  }
  if (next !== m.pointCount) throw new Error(`manifest: chunks sum ${next} != pointCount ${m.pointCount}`)
  const HEX = /^#[0-9a-f]{6}$/i
  let segments: SegmentMeta[] | undefined
  if (m.segments !== undefined) {
    if (!Array.isArray(m.segments)) throw new Error('manifest: segments must be an array')
    const seen = new Set<number>()
    segments = (m.segments as SegmentMeta[]).map((s) => {
      if (typeof s !== 'object' || s === null || !Number.isInteger(s.id) || s.id < 1 || s.id > 255 || typeof s.name !== 'string' || typeof s.color !== 'string' || !HEX.test(s.color)) throw new Error('manifest: segment invalid')
      if (seen.has(s.id)) throw new Error(`manifest: duplicate segment id ${s.id}`)
      seen.add(s.id)
      return { id: s.id, name: s.name, color: s.color.toLowerCase() }
    })
  }
  if (m.segmentsFile !== undefined && typeof m.segmentsFile !== 'string') throw new Error('manifest: segmentsFile must be a string')
  return {
    version: 1,
    name: typeof m.name === 'string' ? m.name : 'dataset',
    source: typeof m.source === 'string' ? m.source : undefined,
    license: typeof m.license === 'string' ? m.license : undefined,
    crs: typeof m.crs === 'string' ? m.crs : undefined,
    units: 'm',
    bounds: m.bounds,
    pointCount: m.pointCount,
    bytesPerPoint: BYTES_PER_POINT,
    file: m.file,
    classMap: (typeof m.classMap === 'object' && m.classMap !== null ? m.classMap : {}) as Record<string, string>,
    chunks: m.chunks as ManifestChunk[],
    ...(segments && { segments }),
    ...(typeof m.segmentsFile === 'string' && { segmentsFile: m.segmentsFile }),
  }
}

export function resolveBinUrl(manifestUrl: string, file: string): string {
  return new URL(file, manifestUrl).href
}

export async function fetchManifest(url: string, fetchFn: typeof fetch = fetch): Promise<{ manifest: Manifest; binUrl: string; segmentsUrl: string | null }> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status} for ${url}`)
  const manifest = validateManifest(await res.json())
  // Relative props like "/data/demo/manifest.json" resolve against the page; absolute URLs pass through.
  const absolute = new URL(url, globalThis.location?.href ?? 'http://localhost/').href
  return { manifest, binUrl: resolveBinUrl(absolute, manifest.file), segmentsUrl: manifest.segmentsFile ? resolveBinUrl(absolute, manifest.segmentsFile) : null }
}
