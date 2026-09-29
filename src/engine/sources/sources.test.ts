import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Http } from '../core/http'
import { HttpError } from '../core/http'
import { parseHnHeader } from './aggregators'
import { boardKey, detectAts } from './detect'
import { adapterFor } from './index'
import type { SourceContext } from './types'
import { relativeDate } from './types'

const fx = (kind: string) => JSON.parse(readFileSync(`fixtures/sources/${kind}.json`, 'utf8'))

/** Serves recorded responses by URL pattern; unknown URLs fail loudly so adapters can't silently call the network. */
function fakeHttp(routes: [RegExp, unknown | ((url: string, body?: unknown) => unknown)][]): Http {
  const handle = (url: string, body?: unknown) => {
    for (const [re, value] of routes) if (re.test(url)) return typeof value === 'function' ? (value as (u: string, b?: unknown) => unknown)(url, body) : value
    throw new HttpError(404, url, `no fixture for ${url}`)
  }
  return {
    getJson: async (url: string, req?: { json?: unknown }) => structuredClone(handle(url, req?.json)),
  } as unknown as Http
}

const ctx = (http: Http, extra: Partial<SourceContext> = {}): SourceContext => ({ http, now: Date.UTC(2026, 8, 28, 12), queries: [], credentials: {}, ...extra })

describe('ATS adapters against recorded responses', () => {
  it('greenhouse', async () => {
    const f = fx('greenhouse')
    const r = await adapterFor('greenhouse').fetch({ token: 'stripe' }, ctx(fakeHttp([[/\/boards\/stripe\/jobs\?/, f.list]])))
    expect(r.complete).toBe(true)
    expect(r.postings).toHaveLength(f.list.jobs.length)
    const p = r.postings[0]!
    expect(p.externalId).toBe(String(f.list.jobs[0].id))
    expect(p.company).toBe('Stripe')
    expect(p.applyUrl).toBe(`https://job-boards.greenhouse.io/stripe/jobs/${f.list.jobs[0].id}`)
    expect(p.descriptionHtml!.length).toBeGreaterThan(100)
    expect(p.postedAt).toBeGreaterThan(Date.UTC(2020, 0, 1))
  })

  it('lever', async () => {
    const f = fx('lever')
    const r = await adapterFor('lever').fetch({ site: 'palantir' }, ctx(fakeHttp([[/api\.lever\.co\/v0\/postings\/palantir/, f.list]])))
    const p = r.postings[0]!
    expect(p.title).toBe(f.list[0].text)
    expect(p.url).toMatch(/^https:\/\/jobs\.lever\.co\/palantir\//)
    expect(p.remoteHint).toBe('hybrid')
    expect(p.countryHint).toBe('SG')
    expect(p.employmentHint).toBe('Full-time')
    expect(p.descriptionHtml).toContain('<h3>')
  })

  it('ashby, including structured compensation', async () => {
    const f = fx('ashby')
    const r = await adapterFor('ashby').fetch({ board: 'openai', name: 'OpenAI' }, ctx(fakeHttp([[/posting-api\/job-board\/openai/, f.list]])))
    const withPay = r.postings.find((p) => p.salary)
    expect(withPay?.salary).toMatchObject({ currency: 'USD', period: 'year' })
    expect(withPay!.salary!.min).toBeGreaterThan(10_000)
    expect(r.postings[0]!.company).toBe('OpenAI')
  })

  it('workday list plus lazy details', async () => {
    const f = fx('workday')
    const http = fakeHttp([
      [/\/jobs$/, (_u: string, body?: unknown) => ((body as { offset: number }).offset === 0 ? f.list : { total: f.list.total, jobPostings: [] })],
      [/\/job\//, f.detail],
    ])
    const cfg = { host: f.host, tenant: f.tenant, site: f.site }
    const r = await adapterFor('workday').fetch(cfg, ctx(http))
    const p = r.postings[0]!
    expect(p.needsDetails).toBe(true)
    expect(p.locationText).toBe('Bengaluru, India')
    expect(p.postedAt).toBe(Date.UTC(2026, 8, 28, 12))
    const d = await adapterFor('workday').details!({ externalId: p.externalId, url: p.url, meta: {} }, cfg, ctx(http))
    expect(d.descriptionHtml!.length).toBeGreaterThan(100)
    expect(d.employmentHint).toBe('Full time')
  })

  it('smartrecruiters list plus details', async () => {
    const f = fx('smartrecruiters')
    const http = fakeHttp([
      [/postings\?limit=100&offset=0/, f.list],
      [/postings\?limit=100&offset=/, { content: [], totalFound: f.list.totalFound }],
      [/postings\/\d+$/, f.detail],
    ])
    const r = await adapterFor('smartrecruiters').fetch({ company: 'ServiceNow' }, ctx(http))
    expect(r.postings[0]).toMatchObject({ company: 'ServiceNow', remoteHint: 'hybrid', countryHint: 'KR' })
    const d = await adapterFor('smartrecruiters').details!({ externalId: r.postings[0]!.externalId, url: '', meta: {} }, { company: 'ServiceNow' }, ctx(http))
    expect(d.descriptionHtml).toContain('<h3>')
  })

  it('recruitee keeps the application questions', async () => {
    const f = fx('recruitee')
    const r = await adapterFor('recruitee').fetch({ company: 'bunq' }, ctx(fakeHttp([[/bunq\.recruitee\.com/, f.list]])))
    const p = r.postings[0]!
    expect(p.company).toBe('bunq')
    expect(Array.isArray(p.questions)).toBe(true)
    expect((p.questions as unknown[]).length).toBeGreaterThan(0)
    expect(p.remoteHint).toBe('hybrid')
  })

  it('workable', async () => {
    const f = fx('workable')
    const http = fakeHttp([
      [/api\/v3\/accounts\/huggingface\/jobs/, f.list],
      [/widget\/accounts\/huggingface/, { name: f.name }],
      [/api\/v2\/accounts\/huggingface\/jobs\//, f.detail],
    ])
    const r = await adapterFor('workable').fetch({ account: 'huggingface' }, ctx(http))
    expect(r.companyName).toBe('Hugging Face')
    expect(r.postings[0]).toMatchObject({ remoteHint: 'remote', countryHint: 'FR', employmentHint: 'full-time' })
  })
})

describe('aggregators against recorded responses', () => {
  it.each([
    ['remotive', /remotive\.com/, (f: { list: unknown }) => f.list],
    ['remoteok', /remoteok\.com/, (f: { list: unknown }) => f.list],
    ['arbeitnow', /arbeitnow\.com/, (f: { list: { data: unknown[] } }) => ({ ...f.list, links: { next: null } })],
    ['themuse', /themuse\.com/, (f: { list: unknown }) => ({ ...(f.list as object), page_count: 1 })],
    ['himalayas', /himalayas\.app/, (f: { list: unknown }) => ({ ...(f.list as object), nextCursor: null })],
  ] as const)('%s', async (kind, re, body) => {
    const f = fx(kind)
    const r = await adapterFor(kind).fetch({}, ctx(fakeHttp([[re, body(f)]])))
    expect(r.postings.length).toBeGreaterThan(0)
    for (const p of r.postings) {
      expect(p.title).toBeTruthy()
      expect(p.company).toBeTruthy()
      expect(p.url).toMatch(/^https?:\/\//)
    }
  })

  it('hn parses the Company | Role | Location convention', async () => {
    const f = fx('hn')
    const r = await adapterFor('hn').fetch({}, ctx(fakeHttp([[/search_by_date/, f.search], [/items\//, f.item]])))
    expect(r.postings.length).toBeGreaterThan(0)
    const h = parseHnHeader('Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k–110k | <a href="https:&#x2F;&#x2F;modash.io">x</a><p>More')
    expect(h).toMatchObject({ company: 'Modash.io', title: 'Senior Product Engineer', location: 'Remote (Europe)', remote: true, firstLink: 'https://modash.io' })
  })

  it('keyed sources explain a missing key instead of failing silently', async () => {
    await expect(adapterFor('adzuna').fetch({}, ctx(fakeHttp([]), { queries: [{ keywords: 'x', location: null, country: 'US', remote: false }] }))).rejects.toMatchObject({ code: 'NO_KEY' })
  })
})

describe('detectAts', () => {
  it.each([
    ['https://boards.greenhouse.io/stripe/jobs/8172508', 'greenhouse', 'stripe', '8172508'],
    ['https://job-boards.greenhouse.io/anthropic/jobs/4020305008', 'greenhouse', 'anthropic', '4020305008'],
    ['https://jobs.lever.co/palantir/6ed76ce8-4156/apply', 'lever', 'palantir', '6ed76ce8-4156'],
    ['https://jobs.ashbyhq.com/openai/8fb1615c-34bf/application', 'ashby', 'openai', '8fb1615c-34bf'],
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/India-Bengaluru/QA_JR1', 'workday', 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'job/India-Bengaluru/QA_JR1'],
    ['https://jobs.smartrecruiters.com/ServiceNow/744000152072409-principal-architect', 'smartrecruiters', 'ServiceNow', '744000152072409'],
    ['https://bunq.recruitee.com/o/senior-legal-counsel-3', 'recruitee', 'bunq', 'senior-legal-counsel-3'],
    ['https://apply.workable.com/huggingface/j/DB4D7C0EC8/', 'workable', 'huggingface', 'DB4D7C0EC8'],
  ] as const)('%s', (url, ats, key, jobId) => {
    const d = detectAts(url)!
    expect(d.ats).toBe(ats)
    expect(boardKey(d.ats, d.board!)).toBe(key)
    expect(d.jobId).toBe(jobId)
  })

  it('recognizes platforms it cannot poll and ignores unrelated URLs', () => {
    expect(detectAts('https://www.linkedin.com/jobs/view/4012345678/')).toMatchObject({ ats: 'linkedin', jobId: '4012345678' })
    expect(detectAts('https://careers-acme.icims.com/jobs/1234/engineer/job')).toMatchObject({ ats: 'icims', jobId: '1234' })
    expect(detectAts('https://stripe.com/jobs/search?gh_jid=8172508')).toMatchObject({ ats: 'greenhouse', board: null, jobId: '8172508' })
    expect(detectAts('https://example.com/careers')).toBeNull()
    expect(detectAts('not a url')).toBeNull()
  })
})

describe('relativeDate', () => {
  it('reads Workday phrasing', () => {
    const now = Date.UTC(2026, 8, 28)
    expect(relativeDate('Posted Today', now)).toBe(now)
    expect(relativeDate('Posted Yesterday', now)).toBe(now - 86_400_000)
    expect(relativeDate('Posted 30+ Days Ago', now)).toBe(now - 30 * 86_400_000)
    expect(relativeDate('whenever', now)).toBeNull()
  })
})
