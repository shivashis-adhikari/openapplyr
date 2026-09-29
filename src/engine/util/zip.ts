import { inflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; data: Buffer }

const MAX_ENTRIES = 5000
const MAX_TOTAL = 200 * 1024 * 1024

/**
 * Minimal ZIP reader (stored and deflate entries) for LinkedIn data exports. Reads the central directory,
 * so it copes with data descriptors. Caps entry count and total size to refuse zip bombs.
 */
export function readZip(buf: Buffer, want?: (name: string) => boolean): ZipEntry[] {
  // End of central directory: signature 0x06054b50, searched backwards past an optional comment.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file.')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) throw new Error('The ZIP file has too many entries.')
  const out: ZipEntry[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The ZIP directory is corrupt.')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || (want && !want(name))) continue
    total += size
    if (total > MAX_TOTAL) throw new Error('The ZIP file is too large to import.')
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The ZIP file is corrupt.')
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(start, start + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw new Error(`Unsupported compression in ${name}.`)
    out.push({ name, data })
  }
  return out
}
