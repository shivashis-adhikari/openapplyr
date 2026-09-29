import type { Salary } from '../../shared/domain'
import { AppError } from '../core/errors'
import { parseSalary } from '../jobs/salary'
import { decodeEntities } from '../util/html'
import type { FetchResult, RawPosting, SearchQuery, SourceAdapter, SourceContext } from './types'
import { parseTime } from './types'

const sig = (ctx: SourceContext) => (ctx.signal ? { signal: ctx.signal } : {})
const need = (ctx: SourceContext, key: string, label: string): string => {
  const v = ctx.credentials[key]
  if (!v) throw new AppError('NO_KEY', `${label} needs an API key. Add it in Settings, Accounts.`, { permanent: true })
  return v
}
const salaryOf = (min: unknown, max: unknown, currency: string | null, period: Salary['period']): Salary | null => {
  const a = Number(min) > 0 ? Number(min) : null
  const b = Number(max) > 0 ? Number(max) : null
  return a || b ? { min: a, max: b, currency, period, text: '' } : null
}
/** A few distinct queries from active hunts, so keyed search APIs are not hammered. */
const topQueries = (ctx: SourceContext, n = 4): SearchQuery[] => {
  const seen = new Set<string>()
  return ctx.queries.filter((q) => {
    const k = `${q.keywords}|${q.location ?? ''}|${q.country ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, n)
}

type RemotiveJob = { id: number; url: string; title: string; company_name: string; job_type?: string; publication_date?: string; candidate_required_location?: string; salary?: string; description?: string; tags?: string[] }

export const remotive: SourceAdapter = {
  kind: 'remotive',
  label: 'Remotive',
  async fetch(_cfg, ctx): Promise<FetchResult> {
    // Remotive asks for at most four calls a day; the poller schedules it every six hours.
    const { jobs } = await ctx.http.getJson<{ jobs: RemotiveJob[] }>('https://remotive.com/api/remote-jobs', { timeoutMs: 60_000, ...sig(ctx) })
    return {
      complete: false,
      postings: jobs.map((j): RawPosting => ({
        externalId: String(j.id),
        title: j.title,
        company: j.company_name,
        url: j.url,
        locationText: j.candidate_required_location || 'Anywhere',
        remoteHint: 'remote',
        descriptionHtml: j.description ?? '',
        postedAt: parseTime(j.publication_date ? `${j.publication_date}Z` : undefined),
        employmentHint: j.job_type?.replace(/_/g, ' '),
        salary: parseSalary(j.salary ?? ''),
        meta: { tags: j.tags ?? [], attribution: 'Remotive' },
      })),
    }
  },
}

type RemoteOkJob = { id?: string; epoch?: number; company?: string; position?: string; tags?: string[]; description?: string; location?: string; apply_url?: string; url?: string; salary_min?: number; salary_max?: number; legal?: string }

export const remoteok: SourceAdapter = {
  kind: 'remoteok',
  label: 'Remote OK',
  async fetch(_cfg, ctx) {
    const list = await ctx.http.getJson<RemoteOkJob[]>('https://remoteok.com/api', { timeoutMs: 60_000, ...sig(ctx) })
    return {
      complete: false,
      postings: list
        .filter((j) => j.id && j.position)
        .map((j): RawPosting => ({
          externalId: String(j.id),
          title: decodeEntities(j.position!),
          company: (j.company ?? '').trim(),
          url: j.url ?? `https://remoteok.com/remote-jobs/${j.id}`,
          applyUrl: j.apply_url,
          locationText: j.location || 'Anywhere',
          remoteHint: 'remote',
          descriptionHtml: j.description ?? '',
          postedAt: j.epoch ? j.epoch * 1000 : null,
          salary: salaryOf(j.salary_min, j.salary_max, 'USD', 'year'),
          meta: { tags: j.tags ?? [], attribution: 'Remote OK' },
        })),
    }
  },
}

type ArbeitnowJob = { slug: string; company_name: string; title: string; description: string; remote: boolean; url: string; tags?: string[]; job_types?: string[]; location?: string; created_at?: number }

export const arbeitnow: SourceAdapter = {
  kind: 'arbeitnow',
  label: 'Arbeitnow',
  async fetch(_cfg, ctx) {
    const postings: RawPosting[] = []
    for (let page = 1; page <= 3; page++) {
      const r = await ctx.http.getJson<{ data: ArbeitnowJob[]; links?: { next?: string | null } }>(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, { timeoutMs: 45_000, ...sig(ctx) })
      for (const j of r.data) {
        postings.push({
          externalId: j.slug,
          title: j.title,
          company: j.company_name,
          url: j.url,
          locationText: j.location ?? '',
          remoteHint: j.remote ? 'remote' : undefined,
          countryHint: 'DE',
          descriptionHtml: j.description,
          postedAt: j.created_at ? j.created_at * 1000 : null,
          employmentHint: (j.job_types ?? []).join(' '),
          meta: { tags: j.tags ?? [], attribution: 'Arbeitnow' },
        })
      }
      if (!r.links?.next) break
    }
    return { complete: false, postings }
  },
}

type MuseJob = { id: number; name: string; contents: string; publication_date?: string; locations?: { name: string }[]; levels?: { name: string }[]; company?: { name: string }; refs?: { landing_page?: string } }

export const themuse: SourceAdapter = {
  kind: 'themuse',
  label: 'The Muse',
  async fetch(_cfg, ctx) {
    const postings: RawPosting[] = []
    const locations = [...new Set(topQueries(ctx).map((q) => q.location).filter((l): l is string => !!l))].slice(0, 3)
    const variants = locations.length ? locations.map((l) => `&location=${encodeURIComponent(l)}`) : ['']
    for (const v of variants) {
      for (let page = 1; page <= 2; page++) {
        const r = await ctx.http.getJson<{ results: MuseJob[]; page_count: number }>(`https://www.themuse.com/api/public/jobs?page=${page}&descending=true${v}`, { timeoutMs: 45_000, ...sig(ctx) })
        for (const j of r.results) {
          postings.push({
            externalId: String(j.id),
            title: j.name,
            company: j.company?.name ?? '',
            url: j.refs?.landing_page ?? `https://www.themuse.com/jobs/${j.id}`,
            locationText: (j.locations ?? []).map((l) => l.name).join('; '),
            descriptionHtml: j.contents,
            postedAt: parseTime(j.publication_date),
            meta: { levels: (j.levels ?? []).map((l) => l.name), attribution: 'The Muse' },
          })
        }
        if (page >= r.page_count) break
      }
    }
    return { complete: false, postings }
  },
}

type HimalayasJob = {
  title: string
  companyName: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string
  currency?: string | null
  locationRestrictions?: string[]
  description?: string
  pubDate?: number
  applicationLink: string
  guid: string
  seniority?: string[]
}

export const himalayas: SourceAdapter = {
  kind: 'himalayas',
  label: 'Himalayas',
  async fetch(_cfg, ctx) {
    const postings: RawPosting[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const r = await ctx.http.getJson<{ jobs: HimalayasJob[]; nextCursor?: string | null }>(`https://himalayas.app/jobs/api?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        timeoutMs: 45_000,
        ...sig(ctx),
      })
      for (const j of r.jobs) {
        const period = /hour/i.test(j.salaryPeriod ?? '') ? 'hour' : /month/i.test(j.salaryPeriod ?? '') ? 'month' : 'year'
        postings.push({
          externalId: j.guid,
          title: j.title,
          company: j.companyName,
          url: j.applicationLink,
          locationText: j.locationRestrictions?.length ? j.locationRestrictions.join('; ') : 'Anywhere',
          remoteHint: 'remote',
          descriptionHtml: j.description ?? '',
          postedAt: j.pubDate ? j.pubDate * 1000 : null,
          employmentHint: j.employmentType,
          salary: salaryOf(j.minSalary, j.maxSalary, j.currency ?? 'USD', period),
          meta: { seniority: j.seniority ?? [], attribution: 'Himalayas' },
        })
      }
      cursor = r.nextCursor ?? undefined
      if (!cursor) break
    }
    return { complete: false, postings }
  },
}

type HnItem = { id: number; created_at_i?: number; text?: string | null; children?: HnItem[]; author?: string }

/** "Acme | Senior Engineer | Remote (US) | Full-time | $150k" -> parts. */
export function parseHnHeader(html: string): { company: string; title: string; location: string; remote: boolean; salaryText: string; firstLink: string | null } {
  const firstLine = decodeEntities(html.split(/<p>/i)[0] ?? '').replace(/<[^>]+>/g, '').trim()
  const parts = firstLine.split(/\s+\|\s+|\s*\|\s*/).map((p) => p.trim()).filter(Boolean)
  const company = parts[0] ?? ''
  const role = parts.slice(1).find((p) => /(engineer|developer|designer|manager|scientist|lead|architect|analyst|head|director|founding|sre|devops|product|marketing|sales|recruiter|writer|researcher|intern)/i.test(p)) ?? parts[1] ?? ''
  const location = parts.slice(1).find((p) => p !== role && /(remote|onsite|on-site|hybrid|[A-Z][a-z]+,\s*[A-Z]{2}\b|\b(US|USA|UK|EU|Europe|NYC|SF|London|Berlin|Toronto)\b)/.test(p)) ?? ''
  const salaryText = parts.find((p) => /[$€£₹]\s?\d|\d+k/i.test(p)) ?? ''
  const link = /href="([^"]+)"/.exec(html)?.[1]
  return { company, title: role, location, remote: /remote/i.test(firstLine), salaryText, firstLink: link ? decodeEntities(link) : null }
}

export const hn: SourceAdapter = {
  kind: 'hn',
  label: 'Hacker News: Who is hiring',
  async fetch(_cfg, ctx) {
    const search = await ctx.http.getJson<{ hits: { objectID: string; title: string }[] }>(
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=5',
      { timeoutMs: 30_000, ...sig(ctx) },
    )
    const story = search.hits.find((h) => /who is hiring/i.test(h.title))
    if (!story) return { complete: false, postings: [] }
    const item = await ctx.http.getJson<HnItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`, { timeoutMs: 60_000, ...sig(ctx) })
    const postings: RawPosting[] = []
    for (const c of item.children ?? []) {
      if (!c.text) continue
      const h = parseHnHeader(c.text)
      if (!h.company || !h.title) continue
      postings.push({
        externalId: String(c.id),
        title: h.title,
        company: h.company,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        applyUrl: h.firstLink && !/ycombinator\.com/.test(h.firstLink) ? h.firstLink : undefined,
        locationText: h.location,
        remoteHint: h.remote ? 'remote' : undefined,
        descriptionHtml: c.text,
        postedAt: c.created_at_i ? c.created_at_i * 1000 : null,
        salary: parseSalary(h.salaryText),
        meta: { thread: story.title, author: c.author ?? null, attribution: 'Hacker News' },
      })
    }
    return { complete: false, postings }
  },
}

const ADZUNA_COUNTRIES = new Set(['gb', 'us', 'ca', 'au', 'de', 'fr', 'in', 'nl', 'nz', 'pl', 'sg', 'za', 'at', 'be', 'br', 'ch', 'es', 'it', 'mx'])
type AdzunaJob = {
  id: string
  title: string
  description?: string
  redirect_url: string
  created?: string
  company?: { display_name?: string }
  location?: { display_name?: string }
  salary_min?: number
  salary_max?: number
  contract_time?: string
  contract_type?: string
}

export const adzuna: SourceAdapter = {
  kind: 'adzuna',
  label: 'Adzuna',
  async fetch(_cfg, ctx) {
    const appId = need(ctx, 'adzunaAppId', 'Adzuna')
    const appKey = need(ctx, 'adzunaAppKey', 'Adzuna')
    const postings: RawPosting[] = []
    for (const q of topQueries(ctx)) {
      const cc = q.country?.toLowerCase() === 'gb' || q.country?.toLowerCase() === 'uk' ? 'gb' : (q.country ?? 'us').toLowerCase()
      const country = ADZUNA_COUNTRIES.has(cc) ? cc : 'us'
      const params = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: '50', what: q.keywords, max_days_old: '21', 'content-type': 'application/json' })
      if (q.location) params.set('where', q.location)
      const r = await ctx.http.getJson<{ results: AdzunaJob[] }>(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`, { timeoutMs: 30_000, ...sig(ctx) })
      for (const j of r.results) {
        postings.push({
          externalId: j.id,
          title: j.title.replace(/<[^>]+>/g, ''),
          company: j.company?.display_name ?? '',
          url: j.redirect_url,
          locationText: j.location?.display_name ?? '',
          countryHint: country.toUpperCase() === 'GB' ? 'GB' : country.toUpperCase(),
          descriptionText: (j.description ?? '').replace(/<[^>]+>/g, ''),
          postedAt: parseTime(j.created),
          employmentHint: [j.contract_time, j.contract_type].filter(Boolean).join(' '),
          salary: salaryOf(j.salary_min, j.salary_max, null, 'year'),
          meta: { truncated: true, attribution: 'Adzuna' },
        })
      }
    }
    return { complete: false, postings }
  },
}

type UsaJobsItem = {
  MatchedObjectId: string
  MatchedObjectDescriptor: {
    PositionTitle: string
    PositionURI: string
    ApplyURI?: string[]
    PositionLocationDisplay?: string
    OrganizationName?: string
    DepartmentName?: string
    PublicationStartDate?: string
    QualificationSummary?: string
    PositionRemuneration?: { MinimumRange?: string; MaximumRange?: string; RateIntervalCode?: string }[]
    UserArea?: { Details?: { JobSummary?: string; MajorDuties?: string[] } }
  }
}

export const usajobs: SourceAdapter = {
  kind: 'usajobs',
  label: 'USAJOBS',
  async fetch(_cfg, ctx) {
    const key = need(ctx, 'usajobsKey', 'USAJOBS')
    const email = need(ctx, 'usajobsEmail', 'USAJOBS')
    const postings: RawPosting[] = []
    for (const q of topQueries(ctx)) {
      const params = new URLSearchParams({ Keyword: q.keywords, ResultsPerPage: '100', DatePosted: '14' })
      if (q.location) params.set('LocationName', q.location)
      const r = await ctx.http.getJson<{ SearchResult: { SearchResultItems: UsaJobsItem[] } }>(`https://data.usajobs.gov/api/search?${params}`, {
        headers: { 'Authorization-Key': key, 'User-Agent': email, Host: 'data.usajobs.gov' },
        timeoutMs: 30_000,
        ...sig(ctx),
      })
      for (const it of r.SearchResult.SearchResultItems) {
        const d = it.MatchedObjectDescriptor
        const pay = d.PositionRemuneration?.[0]
        const period: Salary['period'] = pay?.RateIntervalCode === 'PH' ? 'hour' : 'year'
        const details = d.UserArea?.Details
        postings.push({
          externalId: it.MatchedObjectId,
          title: d.PositionTitle,
          company: d.OrganizationName ?? d.DepartmentName ?? 'US Government',
          url: d.PositionURI,
          applyUrl: d.ApplyURI?.[0],
          locationText: d.PositionLocationDisplay ?? '',
          countryHint: 'US',
          descriptionText: [details?.JobSummary, ...(details?.MajorDuties ?? []), d.QualificationSummary].filter(Boolean).join('\n\n'),
          postedAt: parseTime(d.PublicationStartDate),
          salary: salaryOf(pay?.MinimumRange, pay?.MaximumRange, 'USD', period),
          meta: { attribution: 'USAJOBS' },
        })
      }
    }
    return { complete: false, postings }
  },
}

type JoobleJob = { id: number | string; title: string; location?: string; snippet?: string; salary?: string; type?: string; link: string; company?: string; updated?: string }

export const jooble: SourceAdapter = {
  kind: 'jooble',
  label: 'Jooble',
  async fetch(_cfg, ctx) {
    const key = need(ctx, 'joobleKey', 'Jooble')
    const postings: RawPosting[] = []
    for (const q of topQueries(ctx)) {
      const r = await ctx.http.getJson<{ jobs: JoobleJob[] }>(`https://jooble.org/api/${encodeURIComponent(key)}`, {
        method: 'POST',
        json: { keywords: q.keywords, location: q.location ?? '', page: 1 },
        timeoutMs: 30_000,
        ...sig(ctx),
      })
      for (const j of r.jobs ?? []) {
        postings.push({
          externalId: String(j.id),
          title: j.title,
          company: j.company ?? '',
          url: j.link,
          locationText: j.location ?? '',
          countryHint: q.country,
          descriptionText: (j.snippet ?? '').replace(/<[^>]+>/g, ''),
          postedAt: parseTime(j.updated),
          employmentHint: j.type,
          salary: parseSalary(j.salary ?? ''),
          meta: { truncated: true, attribution: 'Jooble' },
        })
      }
    }
    return { complete: false, postings }
  },
}

type ReedJob = { jobId: number; employerName: string; jobTitle: string; locationName?: string; minimumSalary?: number | null; maximumSalary?: number | null; currency?: string; date?: string; jobDescription?: string; jobUrl: string }

export const reed: SourceAdapter = {
  kind: 'reed',
  label: 'Reed',
  async fetch(_cfg, ctx) {
    const key = need(ctx, 'reedKey', 'Reed')
    const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`
    const postings: RawPosting[] = []
    for (const q of topQueries(ctx)) {
      const params = new URLSearchParams({ keywords: q.keywords, resultsToTake: '100' })
      if (q.location) params.set('locationName', q.location)
      const r = await ctx.http.getJson<{ results: ReedJob[] }>(`https://www.reed.co.uk/api/1.0/search?${params}`, { headers: { Authorization: auth }, timeoutMs: 30_000, ...sig(ctx) })
      for (const j of r.results) {
        const [d, m, y] = (j.date ?? '').split('/')
        postings.push({
          externalId: String(j.jobId),
          title: j.jobTitle,
          company: j.employerName,
          url: j.jobUrl,
          locationText: j.locationName ?? '',
          countryHint: 'GB',
          descriptionText: j.jobDescription ?? '',
          postedAt: y && m && d ? Date.UTC(Number(y), Number(m) - 1, Number(d)) : null,
          salary: salaryOf(j.minimumSalary, j.maximumSalary, j.currency ?? 'GBP', 'year'),
          meta: { truncated: true, attribution: 'Reed' },
        })
      }
    }
    return { complete: false, postings }
  },
}

