import { describe, expect, it } from 'vitest'
import type { Signal } from '../../shared/domain'
import { json } from '../core/db'
import { HttpError } from '../core/http'
import { pollSource, scheduleDuePolls } from '../sources/poller'
import { addBoard, ensureAggregators, syncRegistry, watchUrl } from '../sources/registry'
import type { RawPosting } from '../sources/types'
import { fakeHttp, fixture, testCtx, testServices } from '../test/harness'
import { importText, sliceBody } from './import'
import { ingest } from './ingest'

const posting = (over: Partial<RawPosting> = {}): RawPosting => ({
  externalId: 'x1',
  title: 'Senior Backend Engineer',
  company: 'Northwind',
  url: 'https://northwind.example/jobs/x1',
  locationText: 'Berlin, Germany',
  descriptionHtml: '<p>We build payments in Go. Salary: €80,000 - €95,000 per year.</p>',
  postedAt: Date.UTC(2026, 8, 20),
  ...over,
})

/** Inserts a real source row so foreign keys hold. */
function src(ctx: ReturnType<typeof testCtx>, kind: string, key = kind): { id: number; kind: string } {
  const id = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES (?, ?, ?, '{}', 0)", [kind, key, key]).lastInsertRowid
  return { id, kind }
}

describe('ingest', () => {
  it('normalizes and stores postings, and is idempotent', () => {
    const ctx = testCtx()
    const now = Date.UTC(2026, 8, 28)
    const gh = src(ctx, 'greenhouse')
    const r1 = ingest(ctx.db, gh, { complete: true, postings: [posting()] }, now)
    expect(r1.inserted).toHaveLength(1)
    const row = ctx.db.get<{ title_norm: string; salary_annual_min: number; salary_currency: string; remote: string; locations: string; group_id: number; company_id: number }>(
      'SELECT * FROM jobs WHERE id = ?',
      [r1.inserted[0]],
    )!
    expect(row).toMatchObject({ title_norm: 'senior backend engineer', salary_annual_min: 80000, salary_currency: 'EUR', remote: 'onsite', group_id: r1.inserted[0] })
    expect(json.parse<{ city: string }[]>(row.locations, [])[0]!.city).toBe('Berlin')
    const r2 = ingest(ctx.db, gh, { complete: true, postings: [posting()] }, now + 1000)
    expect(r2).toEqual({ inserted: [], updated: [], reopened: 0, closed: 0 })
  })

  it('closes jobs missing from a complete listing and reopens them when they return', () => {
    const ctx = testCtx()
    const lv = src(ctx, 'lever')
    ingest(ctx.db, lv, { complete: true, postings: [posting(), posting({ externalId: 'x2', title: 'Data Engineer' })] }, 1000)
    const r = ingest(ctx.db, lv, { complete: true, postings: [posting()] }, 2000)
    expect(r.closed).toBe(1)
    expect(ingest(ctx.db, lv, { complete: false, postings: [posting({ externalId: 'x2', title: 'Data Engineer' })] }, 3000).reopened).toBe(1)
  })

  it('groups reposts and cross-source duplicates, counting only same-source reposts', () => {
    const ctx = testCtx()
    const t = Date.UTC(2026, 8, 1)
    const gh = src(ctx, 'greenhouse')
    const rm = src(ctx, 'remotive')
    const a = ingest(ctx.db, gh, { complete: false, postings: [posting()] }, t).inserted[0]!
    const b = ingest(ctx.db, rm, { complete: false, postings: [posting({ externalId: 'r9', url: 'https://remotive.com/x' })] }, t + 1000).inserted[0]!
    const c = ingest(ctx.db, gh, { complete: false, postings: [posting({ externalId: 'x3' })] }, t + 2000).inserted[0]!
    const rows = ctx.db.all<{ id: number; group_id: number; repost_count: number }>('SELECT id, group_id, repost_count FROM jobs ORDER BY id')
    expect(rows.map((r) => r.group_id)).toEqual([a, a, a])
    expect(rows.find((r) => r.id === c)!.repost_count).toBe(1)
    void b
    // Different city is a different role.
    const d = ingest(ctx.db, gh, { complete: false, postings: [posting({ externalId: 'x4', locationText: 'Lisbon, Portugal' })] }, t + 3000).inserted[0]!
    expect(ctx.db.get<{ group_id: number }>('SELECT group_id FROM jobs WHERE id = ?', [d])!.group_id).toBe(d)
  })

  it('keeps a fetched description when a listing-only refresh arrives', () => {
    const ctx = testCtx()
    const wd = src(ctx, 'workday')
    const id = ingest(ctx.db, wd, { complete: false, postings: [posting({ descriptionHtml: undefined, needsDetails: true })] }, 1000).inserted[0]!
    ctx.db.run("UPDATE jobs SET description_md = 'Full description from details', meta = json_set(meta, '$.needsDetails', json('false')) WHERE id = ?", [id])
    ingest(ctx.db, wd, { complete: false, postings: [posting({ descriptionHtml: undefined, needsDetails: true, title: 'Senior Backend Engineer II' })] }, 2000)
    expect(ctx.db.get<{ description_md: string }>('SELECT description_md FROM jobs WHERE id = ?', [id])!.description_md).toBe('Full description from details')
  })

  it('computes signals, including the company domain check', () => {
    const ctx = testCtx()
    const id = ingest(
      ctx.db,
      src(ctx, 'greenhouse'),
      { complete: false, postings: [posting({ descriptionHtml: '<p>Send your resume to hiring.northwind@gmail.com. We are unable to sponsor visas.</p>' })] },
      1000,
    ).inserted[0]!
    const signals = json.parse<Signal[]>(ctx.db.get<{ signals: string }>('SELECT signals FROM jobs WHERE id = ?', [id])!.signals, [])
    expect(signals.map((s) => s.kind).sort()).toEqual(['no_sponsorship', 'scam'])
  })
})

describe('poller', () => {
  it('polls a board from recorded data and schedules scoring', async () => {
    const ctx = testCtx()
    const f = fixture('greenhouse')
    ctx.http = fakeHttp([[/boards\/stripe\/jobs\?/, f.list]])
    const id = addBoard(ctx, 'greenhouse', { token: 'stripe' }, { origin: 'user' })
    const res = await pollSource(ctx, id)
    expect(res!.inserted.length).toBe(f.list.jobs.length)
    const src = ctx.db.get<{ label: string; consecutive_errors: number; next_poll_at: number; job_count: number }>('SELECT * FROM sources WHERE id = ?', [id])!
    expect(src).toMatchObject({ label: 'Stripe', consecutive_errors: 0, job_count: f.list.jobs.length })
    expect(src.next_poll_at).toBeGreaterThan(ctx.now())
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE type = 'match.score'")!.n).toBe(1)
  })

  it('records failures on the source with backoff instead of throwing', async () => {
    const ctx = testCtx()
    ctx.http = fakeHttp([[/greenhouse/, new HttpError(503, 'x', 'down')]])
    const id = addBoard(ctx, 'greenhouse', { token: 'acme' }, { origin: 'user' })
    await expect(pollSource(ctx, id)).resolves.toBeNull()
    const src = ctx.db.get<{ consecutive_errors: number; last_error: string; next_poll_at: number }>('SELECT * FROM sources WHERE id = ?', [id])!
    expect(src.consecutive_errors).toBe(1)
    expect(src.last_error).toMatch(/down/)
    expect(src.next_poll_at).toBeGreaterThan(ctx.now() + 60 * 60_000)
  })

  it('enqueues due sources and respects the registry switch', () => {
    const ctx = testCtx()
    addBoard(ctx, 'lever', { site: 'a' }, { origin: 'user' })
    const reg = addBoard(ctx, 'lever', { site: 'b' }, { origin: 'registry' })
    ctx.db.run('UPDATE sources SET next_poll_at = 0 WHERE id = ?', [reg])
    expect(scheduleDuePolls(ctx)).toBe(2)
    ctx.settings.update({ discovery: { registryEnabled: false } })
    ctx.db.run("UPDATE tasks SET status = 'done'")
    expect(scheduleDuePolls(ctx)).toBe(1)
  })

  it('enables keyed aggregators only when their key exists', () => {
    const ctx = testCtx()
    ensureAggregators(ctx, {})
    const on = () => ctx.db.all<{ kind: string }>('SELECT kind FROM sources WHERE enabled = 1 ORDER BY kind').map((r) => r.kind)
    expect(on()).toEqual(['arbeitnow', 'himalayas', 'hn', 'remoteok', 'remotive', 'themuse'])
    ensureAggregators(ctx, { adzunaAppKey: 'k' })
    expect(on()).toContain('adzuna')
  })
})

describe('watch and import', () => {
  it('loads the bundled registry once, and a second load adds nothing', () => {
    const ctx = testCtx()
    const added = syncRegistry(ctx)
    expect(added).toBeGreaterThan(5000)
    expect(syncRegistry(ctx)).toBe(0)
    const kinds = ctx.db.all<{ kind: string }>("SELECT DISTINCT kind FROM sources WHERE origin = 'registry'").map((r) => r.kind).sort()
    expect(kinds).toEqual(['ashby', 'greenhouse', 'lever', 'recruitee', 'smartrecruiters', 'workable', 'workday'])
  })

  it('watches a company from its careers URL', () => {
    const ctx = testCtx()
    const w = watchUrl(ctx, 'https://jobs.ashbyhq.com/openai')
    expect(w).toMatchObject({ ats: 'ashby', key: 'openai' })
    expect(() => watchUrl(ctx, 'https://example.com/careers')).toThrow(/recognize/)
    expect(() => watchUrl(ctx, 'https://careers-acme.icims.com/jobs/1/x/job')).toThrow(/cannot be watched/)
  })

  it('imports a pasted posting and cuts the body out of the text', async () => {
    const ctx = testCtx()
    const s = testServices(ctx)
    const text = 'Title: Platform Engineer\nCompany: Tidewater\nLocation: Remote, Canada\n\nYou will run our Kubernetes platform and on-call rotation.'
    const id = await importText(ctx, s, text, null)
    const row = ctx.db.get<{ title: string; company_name: string; user_state: string; remote: string }>('SELECT * FROM jobs WHERE id = ?', [id])!
    expect(row).toMatchObject({ title: 'Platform Engineer', company_name: 'Tidewater', user_state: 'saved', remote: 'remote' })
    await expect(importText(ctx, s, 'hello', null)).rejects.toMatchObject({ code: 'NOT_A_JOB' })
    expect(sliceBody('Header nav. We are hiring a designer to lead our system. Footer links.', 'We are hiring', 'lead our system.')).toBe('We are hiring a designer to lead our system.')
  })
})
