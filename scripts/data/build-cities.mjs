// Builds data/cities.json from GeoNames (https://www.geonames.org, CC BY 4.0).
// Keeps cities with population >= 15,000: name, ASCII name, country, admin1 name, lat, lon, population.
// Usage: node scripts/data/build-cities.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'geonames-'))
const get = async (url, file) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  writeFileSync(join(dir, file), Buffer.from(await res.arrayBuffer()))
}
await get('https://download.geonames.org/export/dump/cities15000.zip', 'cities.zip')
await get('https://download.geonames.org/export/dump/admin1CodesASCII.txt', 'admin1.txt')
execFileSync('unzip', ['-o', '-q', join(dir, 'cities.zip'), '-d', dir])

const admin1 = new Map()
for (const line of readFileSync(join(dir, 'admin1.txt'), 'utf8').split('\n')) {
  const [code, name] = line.split('\t')
  if (code && name) admin1.set(code, name)
}
const rows = []
for (const line of readFileSync(join(dir, 'cities15000.txt'), 'utf8').split('\n')) {
  const f = line.split('\t')
  if (f.length < 15) continue
  const [, name, ascii, , lat, lon, , , country, , a1, , , , pop] = f
  rows.push([name, ascii === name ? '' : ascii, country, admin1.get(`${country}.${a1}`) ?? '', Number(Number(lat).toFixed(3)), Number(Number(lon).toFixed(3)), Number(pop)])
}
rows.sort((a, b) => b[6] - a[6])
writeFileSync('data/cities.json', JSON.stringify({ source: 'GeoNames cities15000, CC BY 4.0, https://www.geonames.org', fields: ['name', 'ascii', 'country', 'admin1', 'lat', 'lon', 'population'], rows }))
console.log(`wrote ${rows.length} cities`)
