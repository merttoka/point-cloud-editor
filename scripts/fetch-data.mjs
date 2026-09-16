import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const name = process.argv[2]
if (!['demo', 'full'].includes(name)) {
  console.error('usage: node scripts/fetch-data.mjs demo|full')
  process.exit(1)
}
const base = 'https://github.com/merttoka/point-cloud-editor/releases/download/v0.1-data/'
const dir = `public/data/${name}`
mkdirSync(dir, { recursive: true })
for (const [asset, file] of [[`${name}-manifest.json`, 'manifest.json'], [`${name}-points.bin`, 'points.bin']]) {
  const res = await fetch(base + asset)
  if (!res.ok || !res.body) throw new Error(`${asset}: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length'))
  const dst = `${dir}/${file}`
  if (existsSync(dst) && len > 0 && statSync(dst).size === len) {
    console.log(`skip ${dst} (${len} B, already complete)`)
    continue
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dst))
  console.log(`wrote ${dst} (${statSync(dst).size} B)`)
}
