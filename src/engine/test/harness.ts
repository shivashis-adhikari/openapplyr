import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { PriceBook } from '../ai/prices'
import { Providers } from '../ai/providers'
import { AiService } from '../ai/service'
import { type Ctx, createContext } from '../engine'
import { nullHost } from '../host'
import { type Http, HttpError } from '../core/http'
import { silentLogger } from '../core/log'
import type { Services } from '../services'

/** An engine context backed by an in-memory database and a temp data folder. */
export function testCtx(opts: { demo?: boolean } = {}): Ctx {
  const dataDir = mkdtempSync(join(tmpdir(), 'openapplyr-test-'))
  return createContext({
    dataDir,
    dataKey: randomBytes(32),
    appVersion: 'test',
    resourcesPath: process.cwd(),
    demo: opts.demo ?? true,
    host: nullHost,
    log: silentLogger,
    dbFile: ':memory:',
  })
}

/** Core services with the deterministic mock model assigned to every role. */
export function testServices(ctx: Ctx): Services {
  const prices = new PriceBook(ctx.db)
  const providers = new Providers(ctx.db, ctx.secrets, ctx.http, prices)
  const ai = new AiService(ctx.db, ctx.settings, ctx.log, ctx.bus, providers, prices, () => ctx.now())
  const mock = providers.save({ kind: 'mock', fields: {} })
  for (const role of ['fast', 'writer', 'agent', 'review']) {
    ctx.db.run('INSERT INTO model_roles (role, provider_id, model_id) VALUES (?, ?, ?)', [role, mock.id, 'mock-large'])
  }
  return { prices, providers, ai } as Services
}

/** A valid ZIP with deflated entries, built the way zip tools write them. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, comp)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** A minimal text PDF (Helvetica, one line per entry) with a correct xref table. */
export function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const stream = `BT /F1 11 Tf 50 760 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

export const SAMPLE_RESUME = `Maya Okafor
Senior Backend Engineer
Lisbon, Portugal
maya.okafor@example.com | +351 912 345 678 | linkedin.com/in/maya-okafor-example

SUMMARY
Backend engineer with eight years building payment and data systems.

EXPERIENCE
Senior Backend Engineer, Northwind Payments — Mar 2021 – Present
- Cut settlement batch time from 4 hours to 35 minutes by moving jobs to event-driven workers in Go
- Led a team of 5 engineers through a PostgreSQL 16 upgrade with zero downtime
- Designed the idempotency layer for the card API, handling 1,200 requests per second at peak
Backend Engineer, Tidewater Analytics — Jun 2017 – Feb 2021
- Built ingestion pipelines in Python and Kafka processing 40 million events per day
- Reduced AWS costs by 28% by rightsizing EC2 fleets and adding S3 lifecycle rules

EDUCATION
University of Porto — BSc Computer Science, 2013 – 2017

SKILLS
Go, Python, PostgreSQL, Kafka, AWS, Kubernetes, Terraform, gRPC
`

/** Serves canned responses by URL pattern; unknown URLs fail loudly so tests never touch the network. */
export function fakeHttp(routes: [RegExp, unknown][]): Http {
  const handle = async (url: string, req?: { json?: unknown }) => {
    for (const [re, value] of routes) {
      if (re.test(url)) {
        const v = typeof value === 'function' ? (value as (u: string, b?: unknown) => unknown)(url, req?.json) : value
        if (v instanceof Error) throw v
        return structuredClone(v)
      }
    }
    throw new HttpError(404, url, `no fixture for ${url}`)
  }
  return {
    getJson: handle,
    getText: async (url: string) => {
      const v = await handle(url)
      return { status: 200, url, headers: new Headers(), text: String(v), json: () => v }
    },
    request: async (url: string) => {
      const v = await handle(url)
      return { status: 200, url, headers: new Headers(), text: typeof v === 'string' ? v : JSON.stringify(v), json: () => v }
    },
    setRate() {},
  } as unknown as Http
}

export const fixture = (kind: string) => JSON.parse(readFileSync(`fixtures/sources/${kind}.json`, 'utf8'))
