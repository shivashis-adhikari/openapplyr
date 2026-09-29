import type { Remote, Salary } from '../../shared/domain'
import { HttpError } from '../core/http'
import { countryCode } from '../jobs/geo'
import type { FetchResult, RawPosting, SourceAdapter, SourceConfig, SourceContext } from './types'
import { parseTime, relativeDate } from './types'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const cfgStr = (cfg: SourceConfig, k: string): string => {
  const v = cfg[k]
  if (typeof v !== 'string' || !v) throw new Error(`Source is missing "${k}".`)
  return v
}

async function exists(ctx: SourceContext, url: string, init: { method?: 'GET' | 'POST'; json?: unknown } = {}): Promise<boolean> {
  try {
    await ctx.http.getJson(url, { ...init, timeoutMs: 20_000, retries: 1, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    return true
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return false
    throw err
  }
}

const sal = (min: unknown, max: unknown, currency: unknown, period: Salary['period'], text = ''): Salary | null => {
  const a = typeof min === 'number' && min > 0 ? min : null
  const b = typeof max === 'number' && max > 0 ? max : null
  if (a === null && b === null) return null
  return { min: a, max: b, currency: typeof currency === 'string' && currency ? currency.toUpperCase() : null, period, text }
}

// ---------------------------------------------------------------------------

type GhJob = {
  id: number
  title: string
  absolute_url: string
  location?: { name?: string }
  content?: string
  first_published?: string
  updated_at?: string
  company_name?: string
  requisition_id?: string
  departments?: { name: string }[]
  offices?: { name: string; location?: string | null }[]
  pay_input_ranges?: { min_cents: number; max_cents: number; currency_type: string; title?: string }[]
}

export const greenhouse: SourceAdapter = {
  kind: 'greenhouse',
  label: 'Greenhouse',
  async fetch(cfg, ctx): Promise<FetchResult> {
    const token = cfgStr(cfg, 'token')
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`
    const { jobs } = await ctx.http.getJson<{ jobs: GhJob[] }>(`${base}/jobs?content=true&pay_transparency=true`, { timeoutMs: 45_000, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    let company = str(cfg['name']) || jobs.find((j) => j.company_name)?.company_name || ''
    if (!company) company = (await ctx.http.getJson<{ name?: string }>(base).catch(() => ({ name: '' }))).name || titleCase(token)
    return {
      complete: true,
      companyName: company,
      postings: jobs.map((j): RawPosting => {
        const pay = j.pay_input_ranges?.[0]
        return {
          externalId: String(j.id),
          title: j.title,
          company: j.company_name || company,
          url: j.absolute_url,
          applyUrl: `https://job-boards.greenhouse.io/${token}/jobs/${j.id}`,
          locationText: j.location?.name ?? '',
          descriptionHtml: j.content ?? '',
          postedAt: parseTime(j.first_published ?? j.updated_at),
          salary: pay ? sal(pay.min_cents / 100, pay.max_cents / 100, pay.currency_type, 'year', pay.title ?? '') : null,
          department: j.departments?.[0]?.name,
          meta: { token, requisitionId: j.requisition_id ?? null },
        }
      }),
    }
  },
  isOpen: (p, cfg, ctx) => exists(ctx, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(cfgStr(cfg, 'token'))}/jobs/${p.externalId}`),
}

// ---------------------------------------------------------------------------

type LeverJob = {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt?: number
  country?: string
  workplaceType?: string
  description?: string
  additional?: string
  lists?: { text: string; content: string }[]
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string; department?: string }
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string }
}

const leverBase = (cfg: SourceConfig) => (cfg['eu'] ? 'https://api.eu.lever.co' : 'https://api.lever.co')

export const lever: SourceAdapter = {
  kind: 'lever',
  label: 'Lever',
  async fetch(cfg, ctx) {
    const site = cfgStr(cfg, 'site')
    const jobs = await ctx.http.getJson<LeverJob[]>(`${leverBase(cfg)}/v0/postings/${encodeURIComponent(site)}?mode=json`, { timeoutMs: 45_000, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const company = str(cfg['name']) || titleCase(site)
    return {
      complete: true,
      companyName: company,
      postings: jobs.map((j): RawPosting => {
        const interval = j.salaryRange?.interval ?? ''
        const period: Salary['period'] = /hour/.test(interval) ? 'hour' : /month/.test(interval) ? 'month' : 'year'
        const lists = (j.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`).join('')
        return {
          externalId: j.id,
          title: j.text,
          company,
          url: j.hostedUrl,
          applyUrl: j.applyUrl ?? `${j.hostedUrl}/apply`,
          locationText: (j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location ?? '']).join('; '),
          remoteHint: (({ remote: 'remote', hybrid: 'hybrid', 'on-site': 'onsite', onsite: 'onsite' }) as Record<string, Remote>)[j.workplaceType ?? ''],
          countryHint: j.country ? j.country.toUpperCase() : null,
          descriptionHtml: `${j.description ?? ''}${lists}${j.additional ?? ''}`,
          postedAt: j.createdAt ?? null,
          employmentHint: j.categories?.commitment,
          salary: j.salaryRange ? sal(j.salaryRange.min, j.salaryRange.max, j.salaryRange.currency, period) : null,
          department: j.categories?.team ?? j.categories?.department,
          meta: { site },
        }
      }),
    }
  },
  isOpen: (p, cfg, ctx) => exists(ctx, `${leverBase(cfg)}/v0/postings/${encodeURIComponent(cfgStr(cfg, 'site'))}/${p.externalId}`),
}

// ---------------------------------------------------------------------------

type AshbyComp = { compensationType: string; interval: string; currencyCode: string; minValue: number | null; maxValue: number | null }
type AshbyJob = {
  id: string
  title: string
  department?: string
  employmentType?: string
  location?: string
  secondaryLocations?: { location: string }[]
  publishedAt?: string
  isListed?: boolean
  isRemote?: boolean
  workplaceType?: string | null
  address?: { postalAddress?: { addressCountry?: string; addressLocality?: string; addressRegion?: string } }
  jobUrl: string
  applyUrl?: string
  descriptionHtml?: string
  compensation?: { summaryComponents?: AshbyComp[]; compensationTierSummary?: string }
}

const ashbyCache = new Map<string, { at: number; ids: Set<string> }>()

export const ashby: SourceAdapter = {
  kind: 'ashby',
  label: 'Ashby',
  async fetch(cfg, ctx) {
    const board = cfgStr(cfg, 'board')
    const { jobs } = await ctx.http.getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`, {
      timeoutMs: 60_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    ashbyCache.set(board, { at: ctx.now, ids: new Set(jobs.map((j) => j.id)) })
    const company = str(cfg['name']) || titleCase(board)
    return {
      complete: true,
      companyName: company,
      postings: jobs
        .filter((j) => j.isListed !== false)
        .map((j): RawPosting => {
          const pay = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary')
          const period: Salary['period'] = pay ? (/HOUR/.test(pay.interval) ? 'hour' : /MONTH/.test(pay.interval) ? 'month' : 'year') : null
          const wp = (j.workplaceType ?? '').toLowerCase()
          return {
            externalId: j.id,
            title: j.title,
            company,
            url: j.jobUrl,
            applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
            locationText: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join('; '),
            remoteHint: wp === 'remote' || j.isRemote ? 'remote' : wp === 'hybrid' ? 'hybrid' : wp === 'onsite' ? 'onsite' : undefined,
            countryHint: countryCode(j.address?.postalAddress?.addressCountry ?? ''),
            descriptionHtml: j.descriptionHtml ?? '',
            postedAt: parseTime(j.publishedAt),
            employmentHint: j.employmentType?.replace(/([a-z])([A-Z])/g, '$1 $2'),
            salary: pay ? sal(pay.minValue, pay.maxValue, pay.currencyCode, period, j.compensation?.compensationTierSummary ?? '') : null,
            department: j.department,
            meta: { board },
          }
        }),
    }
  },
  async isOpen(p, cfg, ctx) {
    const board = cfgStr(cfg, 'board')
    const cached = ashbyCache.get(board)
    if (cached && ctx.now - cached.at < 10 * 60_000) return cached.ids.has(p.externalId)
    const r = await this.fetch(cfg, ctx)
    return r.postings.some((x) => x.externalId === p.externalId)
  },
}

// ---------------------------------------------------------------------------

type WdPosting = { title: string; externalPath: string; locationsText?: string; postedOn?: string; bulletFields?: string[] }
type WdDetail = {
  jobPostingInfo: {
    title: string
    jobDescription?: string
    location?: string
    additionalLocations?: string[]
    timeType?: string
    remoteType?: string
    postedOn?: string
    startDate?: string
    country?: { descriptor?: string }
    externalUrl?: string
    canApply?: boolean
  }
  hiringOrganization?: { name?: string }
}

/** Workday prints "India, Bengaluru" and "US, CA, Santa Clara": country first. */
function workdayLocation(text: string | undefined): string {
  if (!text || /^\d+ locations?$/i.test(text.trim())) return ''
  const parts = text.split(',').map((p) => p.trim())
  const first = parts[0] === 'US' ? 'US' : countryCode(parts[0] ?? '')
  return first && parts.length > 1 ? [...parts.slice(1).reverse(), parts[0]].join(', ') : text
}

export const workday: SourceAdapter = {
  kind: 'workday',
  label: 'Workday',
  async fetch(cfg, ctx) {
    const host = cfgStr(cfg, 'host')
    const tenant = cfgStr(cfg, 'tenant')
    const site = cfgStr(cfg, 'site')
    const base = `https://${host}/wday/cxs/${tenant}/${site}`
    const company = str(cfg['name']) || titleCase(tenant)
    const seen = new Map<string, WdPosting>()
    const searches = ctx.queries.length ? [...new Set(ctx.queries.map((q) => q.keywords))].slice(0, 4) : ['']
    const pagesPer = ctx.queries.length ? 5 : 10
    let exhaustive = !ctx.queries.length
    for (const searchText of searches) {
      for (let page = 0; page < pagesPer; page++) {
        const r = await ctx.http.getJson<{ total?: number; jobPostings?: WdPosting[] }>(`${base}/jobs`, {
          method: 'POST',
          json: { appliedFacets: {}, limit: 20, offset: page * 20, searchText },
          timeoutMs: 30_000,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        const list = r.jobPostings ?? []
        for (const p of list) seen.set(p.externalPath, p)
        if (list.length < 20) break
        if (page === pagesPer - 1 && (r.total ?? 0) > seen.size) exhaustive = false
      }
    }
    return {
      complete: exhaustive,
      companyName: company,
      postings: [...seen.values()].map(
        (p): RawPosting => ({
          externalId: p.externalPath,
          title: p.title,
          company,
          url: `https://${host}/${site}${p.externalPath}`,
          applyUrl: `https://${host}/${site}${p.externalPath}/apply`,
          locationText: workdayLocation(p.locationsText),
          postedAt: relativeDate(p.postedOn, ctx.now),
          needsDetails: true,
          meta: { host, tenant, site, externalPath: p.externalPath, reqId: p.bulletFields?.[0] ?? null },
        }),
      ),
    }
  },
  async details(p, cfg, ctx) {
    const base = `https://${cfgStr(cfg, 'host')}/wday/cxs/${cfgStr(cfg, 'tenant')}/${cfgStr(cfg, 'site')}`
    const d = await ctx.http.getJson<WdDetail>(`${base}${p.externalId}`, { timeoutMs: 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const i = d.jobPostingInfo
    const remote = /remote/i.test(i.remoteType ?? '') ? 'remote' : /hybrid/i.test(i.remoteType ?? '') ? 'hybrid' : undefined
    return {
      descriptionHtml: i.jobDescription ?? '',
      locationText: [workdayLocation(i.location), ...(i.additionalLocations ?? []).map(workdayLocation)].filter(Boolean).join('; '),
      remoteHint: remote,
      countryHint: countryCode(i.country?.descriptor ?? ''),
      employmentHint: i.timeType,
      ...(i.externalUrl ? { url: i.externalUrl } : {}),
      needsDetails: false,
    }
  },
  async isOpen(p, cfg, ctx) {
    const base = `https://${cfgStr(cfg, 'host')}/wday/cxs/${cfgStr(cfg, 'tenant')}/${cfgStr(cfg, 'site')}`
    try {
      const d = await ctx.http.getJson<WdDetail>(`${base}${p.externalId}`, { timeoutMs: 20_000, retries: 1 })
      return d.jobPostingInfo.canApply !== false
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return false
      throw err
    }
  },
}

// ---------------------------------------------------------------------------

type SrPosting = {
  id: string
  name: string
  releasedDate?: string
  company?: { name?: string; identifier?: string }
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string }
  typeOfEmployment?: { label?: string }
  experienceLevel?: { label?: string }
  department?: { label?: string }
}
type SrDetail = SrPosting & {
  active?: boolean
  applyUrl?: string
  postingUrl?: string
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> }
}

export const smartrecruiters: SourceAdapter = {
  kind: 'smartrecruiters',
  label: 'SmartRecruiters',
  async fetch(cfg, ctx) {
    const company = cfgStr(cfg, 'company')
    const all: SrPosting[] = []
    const qs = ctx.queries.length ? [...new Set(ctx.queries.map((q) => q.keywords))].slice(0, 4) : ['']
    let exhaustive = !ctx.queries.length
    for (const q of qs) {
      for (let page = 0; page < 5; page++) {
        const r = await ctx.http.getJson<{ content: SrPosting[]; totalFound: number }>(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=100&offset=${page * 100}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
          { timeoutMs: 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        )
        all.push(...r.content)
        if (r.content.length < 100) break
        if (page === 4 && r.totalFound > (page + 1) * 100) exhaustive = false
      }
    }
    const name = str(cfg['name']) || all[0]?.company?.name || company
    const byId = new Map(all.map((p) => [p.id, p]))
    return {
      complete: exhaustive,
      companyName: name,
      postings: [...byId.values()].map((p): RawPosting => {
        const l = p.location ?? {}
        return {
          externalId: p.id,
          title: p.name,
          company: p.company?.name ?? name,
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${p.id}`,
          locationText: [l.city, l.region, l.country ? l.country.toUpperCase() : ''].filter(Boolean).join(', '),
          remoteHint: l.remote ? 'remote' : l.hybrid ? 'hybrid' : l.city ? 'onsite' : undefined,
          countryHint: l.country ? l.country.toUpperCase() : null,
          postedAt: parseTime(p.releasedDate),
          employmentHint: p.typeOfEmployment?.label,
          department: p.department?.label,
          needsDetails: true,
          meta: { company, experienceLevel: p.experienceLevel?.label ?? null },
        }
      }),
    }
  },
  async details(p, cfg, ctx) {
    const d = await ctx.http.getJson<SrDetail>(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(cfgStr(cfg, 'company'))}/postings/${p.externalId}`, {
      timeoutMs: 30_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const html = Object.values(d.jobAd?.sections ?? {})
      .filter((s): s is { title?: string; text?: string } => !!s?.text)
      .map((s) => `${s.title ? `<h3>${s.title}</h3>` : ''}${s.text}`)
      .join('')
    return { descriptionHtml: html, ...(d.applyUrl ? { applyUrl: d.applyUrl } : {}), ...(d.postingUrl ? { url: d.postingUrl } : {}), needsDetails: false }
  },
  async isOpen(p, cfg, ctx) {
    try {
      const d = await ctx.http.getJson<SrDetail>(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(cfgStr(cfg, 'company'))}/postings/${p.externalId}`, { timeoutMs: 20_000, retries: 1 })
      return d.active !== false
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return false
      throw err
    }
  },
}

// ---------------------------------------------------------------------------

type RecruiteeOffer = {
  id: number
  title: string
  company_name?: string
  careers_url: string
  careers_apply_url?: string
  location?: string
  country_code?: string
  remote?: boolean
  hybrid?: boolean
  on_site?: boolean
  description?: string
  requirements?: string
  published_at?: string
  employment_type_code?: string
  status?: string
  department?: string | null
  salary?: { min?: string | number | null; max?: string | number | null; currency?: string | null; period?: string | null }
  open_questions?: unknown[]
}

export const recruitee: SourceAdapter = {
  kind: 'recruitee',
  label: 'Recruitee',
  async fetch(cfg, ctx) {
    const company = cfgStr(cfg, 'company')
    const { offers } = await ctx.http.getJson<{ offers: RecruiteeOffer[] }>(`https://${encodeURIComponent(company)}.recruitee.com/api/offers/`, {
      timeoutMs: 45_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const name = str(cfg['name']) || offers[0]?.company_name || titleCase(company)
    return {
      complete: true,
      companyName: name,
      postings: offers
        .filter((o) => !o.status || o.status === 'published')
        .map((o): RawPosting => {
          const period = /hour/i.test(o.salary?.period ?? '') ? 'hour' : /month/i.test(o.salary?.period ?? '') ? 'month' : 'year'
          return {
            externalId: String(o.id),
            title: o.title,
            company: o.company_name ?? name,
            url: o.careers_url,
            applyUrl: o.careers_apply_url,
            locationText: o.location ?? '',
            remoteHint: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : undefined,
            countryHint: o.country_code ?? null,
            descriptionHtml: `${o.description ?? ''}${o.requirements ? `<h3>Requirements</h3>${o.requirements}` : ''}`,
            postedAt: parseTime(o.published_at),
            employmentHint: o.employment_type_code?.replace(/_/g, ' '),
            salary: sal(Number(o.salary?.min) || null, Number(o.salary?.max) || null, o.salary?.currency, period),
            department: o.department ?? undefined,
            questions: o.open_questions ?? [],
            meta: { company },
          }
        }),
    }
  },
}

// ---------------------------------------------------------------------------

type WorkableJob = {
  id: number
  shortcode: string
  title: string
  remote?: boolean
  workplace?: string
  location?: { country?: string; countryCode?: string; city?: string; region?: string | null }
  locations?: { country?: string; countryCode?: string; city?: string; region?: string | null }[]
  published?: string
  type?: string
  department?: string[]
}

export const workable: SourceAdapter = {
  kind: 'workable',
  label: 'Workable',
  async fetch(cfg, ctx) {
    const account = cfgStr(cfg, 'account')
    const results: WorkableJob[] = []
    let token: string | undefined
    for (let page = 0; page < 10; page++) {
      const r = await ctx.http.getJson<{ results: WorkableJob[]; nextPage?: string }>(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(account)}/jobs`, {
        method: 'POST',
        json: token ? { token } : {},
        timeoutMs: 30_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      results.push(...r.results)
      token = r.nextPage
      if (!token) break
    }
    let name = str(cfg['name'])
    if (!name) name = (await ctx.http.getJson<{ name?: string }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`).catch(() => ({ name: '' }))).name || titleCase(account)
    const place = (l: WorkableJob['location']) => [l?.city, l?.region, l?.country].filter(Boolean).join(', ')
    return {
      complete: !token,
      companyName: name,
      postings: results.map((j): RawPosting => ({
        externalId: j.shortcode,
        title: j.title,
        company: name,
        url: `https://apply.workable.com/${account}/j/${j.shortcode}/`,
        applyUrl: `https://apply.workable.com/${account}/j/${j.shortcode}/apply/`,
        locationText: [...new Set([place(j.location), ...(j.locations ?? []).map(place)].filter(Boolean))].join('; '),
        remoteHint: j.workplace === 'remote' || j.remote ? 'remote' : j.workplace === 'hybrid' ? 'hybrid' : j.workplace === 'on_site' ? 'onsite' : undefined,
        countryHint: j.location?.countryCode ?? null,
        postedAt: parseTime(j.published),
        employmentHint: ({ full: 'full-time', part: 'part-time', contract: 'contract', temporary: 'temporary', internship: 'internship' } as Record<string, string>)[j.type ?? ''] ?? j.type,
        department: j.department?.[0],
        needsDetails: true,
        meta: { account },
      })),
    }
  },
  async details(p, cfg, ctx) {
    const d = await ctx.http.getJson<{ description?: string; requirements?: string; benefits?: string }>(
      `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(cfgStr(cfg, 'account'))}/jobs/${p.externalId}`,
      { timeoutMs: 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    )
    const html = [d.description, d.requirements && `<h3>Requirements</h3>${d.requirements}`, d.benefits && `<h3>Benefits</h3>${d.benefits}`].filter(Boolean).join('')
    return { descriptionHtml: html, needsDetails: false }
  },
  isOpen: (p, cfg, ctx) => exists(ctx, `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(cfgStr(cfg, 'account'))}/jobs/${p.externalId}`),
}
