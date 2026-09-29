import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootEngine } from './boot'
import { silentLogger } from './core/log'
import { nullHost } from './host'

it('boots with a handler for every procedure in the API contract', async () => {
  const booted = await bootEngine({
    dataDir: mkdtempSync(join(tmpdir(), 'openapplyr-boot-')),
    dataKey: randomBytes(32),
    appVersion: 'test',
    resourcesPath: process.cwd(),
    demo: true,
    host: nullHost,
    log: silentLogger,
    onDeleteAll: async () => undefined,
  })
  try {
    expect(booted.ctx.router.missing()).toEqual([])
    expect(await booted.ctx.router.handle('app.status', undefined)).toMatchObject({ version: 'test', onboarded: true })
    // The sample workspace went through the real pipeline.
    const n = (sql: string) => booted.ctx.db.get<{ n: number }>(sql)!.n
    expect(n('SELECT COUNT(*) n FROM jobs')).toBe(16)
    expect(n("SELECT COUNT(*) n FROM job_scores WHERE stage = 'judged'")).toBeGreaterThan(5)
    expect(n("SELECT COUNT(*) n FROM packages WHERE status IN ('ready', 'approved')")).toBeGreaterThan(3)
    expect(n("SELECT COUNT(*) n FROM resumes WHERE kind = 'tailored'")).toBeGreaterThan(3)
    // The sample person lives in Lisbon: every document uses A4.
    expect(n("SELECT COUNT(*) n FROM resumes WHERE page_size != 'A4'")).toBe(0)
    expect(n('SELECT COUNT(*) n FROM interviews')).toBe(2)
    // The first interview comes with likely questions, so Prep has something to show.
    expect(n("SELECT COUNT(*) n FROM prep_items WHERE kind = 'questions'")).toBeGreaterThan(0)
    expect(n('SELECT COUNT(*) n FROM sources WHERE enabled = 1')).toBe(0)
    const today = (await booted.ctx.router.handle('today.summary', undefined)) as { items: { kind: string }[] }
    expect(today.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['question', 'dry_run', 'mail', 'outbox', 'package']))
  } finally {
    await booted.stop()
  }
}, 60_000)

it('exports a folder whose database copy has no keys or passwords', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'openapplyr-export-'))
  const booted = await bootEngine({ dataDir, dataKey: randomBytes(32), appVersion: 'test', resourcesPath: process.cwd(), demo: true, host: nullHost, log: silentLogger, onDeleteAll: async () => undefined })
  try {
    booted.ctx.secrets.put('sk-live-secret')
    const out = join(dataDir, 'export')
    await booted.ctx.router.handle('data.export', { path: out })
    const { DatabaseSync } = await import('node:sqlite')
    const copy = new DatabaseSync(join(out, 'openapplyr.db'))
    expect(copy.prepare('SELECT COUNT(*) n FROM secrets').get()).toEqual({ n: 0 })
    expect((copy.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n).toBeGreaterThan(0)
    copy.close()
    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(join(out, 'profile.json'), 'utf8')).basics.name).toBe('Maya Okafor')
  } finally {
    await booted.stop()
  }
}, 60_000)
