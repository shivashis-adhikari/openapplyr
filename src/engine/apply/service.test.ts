import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeAts } from '../../../tools/fake-ats/server'
import type { Profile } from '../../shared/domain'
import { ingest } from '../jobs/ingest'
import { heuristicResume, toProfile } from '../profile/extract'
import { saveProfile } from '../profile/store'
import { Deferred } from '../scheduler/queue'
import { SAMPLE_RESUME, makePdf, testCtx, testServices } from '../test/harness'
import { createApplication } from '../tracker/applications'
import { BrowserManager } from './browser'
import { ApplyService, generatePassword } from './run'
import { nextActiveTime } from './pacing'

const base = toProfile(heuristicResume(SAMPLE_RESUME))
const profile: Profile = { ...base, jobSearch: { ...base.jobSearch, workAuthorization: [{ country: 'PT', authorized: true, needsSponsorship: false }] } }
const dir = mkdtempSync(join(tmpdir(), 'openapplyr-run-'))
const resume = join(dir, 'Maya_Okafor_Resume.pdf')
writeFileSync(resume, makePdf(['Maya Okafor']))

let browser: Browser | null = null
let ats: Awaited<ReturnType<typeof startFakeAts>>
beforeAll(async () => {
  ats = await startFakeAts()
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null)
}, 60_000) // a cold Chrome start on a busy CI runner can take well over the default 10 seconds
afterAll(async () => {
  await browser?.close()
  await ats.close()
}, 30_000)

// Mid-morning, inside the default active hours, so pacing never depends on when the tests run.
const MORNING = (() => {
  const d = new Date()
  d.setHours(10, 0, 0, 0)
  return d.getTime()
})()

function setup(path: string) {
  const ctx = testCtx()
  let clock = MORNING
  ctx.now = () => (clock += 1)
  const s = testServices(ctx)
  saveProfile(ctx.db, profile)
  const url = `${ats.url}${path}`
  const srcId = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES ('remotive', 'default', 'x', '{}', 0)").lastInsertRowid
  ingest(ctx.db, { id: srcId, kind: 'remotive' }, { complete: true, postings: [{ externalId: '1', title: 'Senior Backend Engineer', company: 'Acme', url, applyUrl: url, locationText: 'Lisbon, Portugal', descriptionHtml: '<p>Go</p>', postedAt: Date.now() }] }, Date.now())
  const job = ctx.db.get<{ id: number; group_id: number }>('SELECT id, group_id FROM jobs')!
  const pkg = ctx.db.run("INSERT INTO packages (job_id, status, created_at) VALUES (?, 'approved', 0)", [job.id]).lastInsertRowid
  const appId = createApplication(ctx.db, { jobId: job.id, groupKey: `job:${job.group_id}`, companyId: null, company: 'Acme', title: 'Senior Backend Engineer', huntId: null, packageId: pkg, status: 'queued', channel: 'ats', url, source: 'user' }, Date.now())
  const manager = new BrowserManager(ctx, () => browser!.newContext({ viewport: { width: 1280, height: 900 } }))
  const service = new ApplyService(ctx, s, null, manager, async () => ({ resume, coverLetter: null }))
  const app = () => ctx.db.get<{ status: string; applied_at: number | null; evidence_dir: string | null; method: string | null }>('SELECT status, applied_at, evidence_dir, method FROM applications WHERE id = ?', [appId])!
  const run = () => ctx.db.get<{ id: number; status: string; mode: string; question: string | null }>('SELECT id, status, mode, question FROM runs ORDER BY id DESC LIMIT 1')!
  return { ctx, service, appId, app, run, pkg, manager }
}

const hasChrome = !!process.env.CI || (await chromium.launch({ channel: 'chrome', headless: true }).then((b) => (b.close(), true)).catch(() => false))

describe('pacing', () => {
  it('finds the next moment inside active hours, including windows that cross midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m).getTime()
    expect(nextActiveTime(at(10), { start: '08:00', end: '21:00' })).toBe(at(10))
    expect(nextActiveTime(at(22), { start: '08:00', end: '21:00' })).toBe(new Date(2026, 8, 29, 8, 0).getTime())
    expect(nextActiveTime(at(6), { start: '08:00', end: '21:00' })).toBe(at(8))
    expect(nextActiveTime(at(23), { start: '22:00', end: '02:00' })).toBe(at(23))
  })

  it('generates tenant passwords that meet common rules', () => {
    const p = generatePassword()
    expect(p).toMatch(/[A-Z]/)
    expect(p).toMatch(/[a-z]/)
    expect(p).toMatch(/\d/)
    expect(p).toMatch(/[^A-Za-z0-9]/)
    expect(p.length).toBeGreaterThanOrEqual(16)
  })
})

describe('sample workspace', () => {
  it('never opens a real site: sample documents come from a stand-in model', async () => {
    const { ctx, service, app, appId } = setup('/greenhouse/jobs/1')
    ctx.db.run('UPDATE applications SET url = ?', ['https://job-boards.greenhouse.io/acme/jobs/1'])
    await service.run({ applicationId: appId, manual: true }, new AbortController().signal)
    // Approved but never sent: it stays queued, with a note saying why, rather than looking like a failure.
    expect(app().status).toBe('queued')
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM runs')!.n).toBe(0)
    expect(ctx.db.get<{ data: string }>("SELECT data FROM events WHERE type = 'note'")!.data).toMatch(/sample workspace/)
  })
})

describe.skipIf(!hasChrome)('application runs', () => {
  it('starts with a dry run (trust ramp), then sends for real with evidence', async () => {
    const { ctx, service, app, run, appId, pkg, manager } = setup('/greenhouse/jobs/1')
    const before = ats.submissions.length
    await service.run({ applicationId: appId }, new AbortController().signal)
    expect(run()).toMatchObject({ status: 'dry_run_done', mode: 'dry_run' })
    expect(app().status).toBe('needs_user')
    expect(ats.submissions.length).toBe(before)
    expect(ctx.settings.get().automation.trustRampRemaining).toBe(2)

    // Same host within a minute: pacing defers even runs the user starts.
    await expect(service.run({ applicationId: appId, mode: 'submit', manual: true }, new AbortController().signal)).rejects.toBeInstanceOf(Deferred)
    ctx.settings.update({ automation: { perHostGapSeconds: 10 } })
    ctx.db.run('UPDATE runs SET started_at = started_at - 60000')
    await service.run({ applicationId: appId, mode: 'submit', manual: true }, new AbortController().signal)
    expect(run()).toMatchObject({ status: 'submitted', mode: 'submit' })
    const a = app()
    expect(a).toMatchObject({ status: 'applied', method: 'agent' })
    expect(a.applied_at).not.toBeNull()
    expect(ats.submissions.length).toBe(before + 1)
    for (const f of ['before-submit.jpg', 'after-submit.jpg', 'fields.json', 'Maya_Okafor_Resume.pdf']) expect(existsSync(join(a.evidence_dir!, f))).toBe(true)
    expect(ctx.db.get<{ status: string }>('SELECT status FROM packages WHERE id = ?', [pkg])!.status).toBe('applied')
    // A sent application is never run again.
    await service.run({ applicationId: appId, mode: 'submit', manual: true }, new AbortController().signal)
    expect(ats.submissions.length).toBe(before + 1)
    await manager.close()
  }, 120_000)

  it('waits for the user on a question it cannot answer, then finishes with their answer', async () => {
    const { ctx, service, app, run, appId, manager } = setup('/wizard/1')
    ctx.settings.update({ automation: { trustRampRemaining: 0 } })
    const done = service.run({ applicationId: appId, manual: true }, new AbortController().signal)
    for (let i = 0; i < 100 && run()?.status !== 'needs_user'; i++) await new Promise((r) => setTimeout(r, 200))
    expect(run().question).toMatch(/favourite colour/)
    expect(app().status).toBe('needs_user')
    expect(service.reply(run().id, { kind: 'answer', fieldName: 'colour', answer: 'Green' })).toBe(true)
    await done
    expect(run().status).toBe('submitted')
    expect(ats.submissions.at(-1)!.fields['colour']).toBe('Green')
    await manager.close()
  }, 120_000)

  it('skips a posting that has closed and frees the job for a later application', async () => {
    const { ctx, service, app, appId } = setup('/greenhouse/jobs/1')
    ctx.db.run('UPDATE jobs SET closed_at = 1')
    await service.run({ applicationId: appId }, new AbortController().signal)
    expect(app().status).toBe('failed')
    expect(ctx.db.get<{ archived: number }>('SELECT archived FROM applications')!.archived).toBe(1)
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM runs')!.n).toBe(0)
  })

  it('can be stopped while it waits', async () => {
    const { ctx, service, app, run, appId, manager } = setup('/wizard/1')
    ctx.settings.update({ automation: { trustRampRemaining: 0 } })
    const done = service.run({ applicationId: appId, manual: true }, new AbortController().signal)
    for (let i = 0; i < 100 && run()?.status !== 'needs_user'; i++) await new Promise((r) => setTimeout(r, 200))
    expect(service.stop(run().id)).toBe(true)
    await done
    expect(run().status).toBe('stopped')
    expect(app().status).toBe('failed')
    await manager.close()
  }, 120_000)
})
