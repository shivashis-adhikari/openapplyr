import type { Remote, Salary } from '../../shared/domain'
import type { Http } from '../core/http'

export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'recruitee', 'workable'] as const
export const AGGREGATOR_KINDS = ['remotive', 'remoteok', 'arbeitnow', 'themuse', 'himalayas', 'hn', 'adzuna', 'usajobs', 'jooble', 'reed'] as const
export type AtsKind = (typeof ATS_KINDS)[number]
export type AggregatorKind = (typeof AGGREGATOR_KINDS)[number]
export type SourceKind = AtsKind | AggregatorKind | 'manual'

/** A posting as a source reports it, before normalization. */
export type RawPosting = {
  externalId: string
  title: string
  company: string
  url: string
  applyUrl?: string | undefined
  locationText: string
  remoteHint?: Remote | undefined
  countryHint?: string | null | undefined
  descriptionHtml?: string | undefined
  descriptionText?: string | undefined
  postedAt?: number | null | undefined
  employmentHint?: string | undefined
  salary?: Salary | null | undefined
  department?: string | undefined
  /** The listing omitted the description; call details() before scoring. */
  needsDetails?: boolean | undefined
  /** Application questions known from the API (Greenhouse, Recruitee). */
  questions?: unknown
  meta?: Record<string, unknown> | undefined
}

export type FetchResult = {
  postings: RawPosting[]
  /** True when the listing is the full board, so absent jobs can be marked closed. */
  complete: boolean
  companyName?: string | undefined
}

export type SearchQuery = { keywords: string; location: string | null; country: string | null; remote: boolean }

export type SourceContext = {
  http: Http
  now: number
  signal?: AbortSignal | undefined
  /** Derived from active hunts; used by search-style sources. */
  queries: SearchQuery[]
  /** Credentials for keyed sources (Adzuna, USAJobs, Jooble, Reed). */
  credentials: Record<string, string>
}

export type SourceConfig = Record<string, string | boolean | number | undefined>

export interface SourceAdapter {
  kind: SourceKind
  label: string
  fetch(cfg: SourceConfig, ctx: SourceContext): Promise<FetchResult>
  details?(posting: { externalId: string; url: string; meta: Record<string, unknown> }, cfg: SourceConfig, ctx: SourceContext): Promise<Partial<RawPosting>>
  isOpen?(posting: { externalId: string; url: string; meta: Record<string, unknown> }, cfg: SourceConfig, ctx: SourceContext): Promise<boolean>
}

/** Workday "Posted 3 Days Ago" and similar relative dates. */
export function relativeDate(text: string | undefined, now: number): number | null {
  if (!text) return null
  const t = text.toLowerCase()
  if (/today|just posted|\bnow\b/.test(t)) return now
  if (/yesterday/.test(t)) return now - 86_400_000
  const m = /(\d+)\+?\s*(hour|day|week|month)s?/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] === 'hour' ? 3_600_000 : m[2] === 'day' ? 86_400_000 : m[2] === 'week' ? 7 * 86_400_000 : 30 * 86_400_000
  return now - n * unit
}

export function parseTime(v: unknown): number | null {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v.replace(' UTC', 'Z').replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
  return Number.isFinite(t) ? t : null
}
