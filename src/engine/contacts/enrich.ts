import { resolveMx } from 'node:dns/promises'
import type { Http } from '../core/http'
import { HttpError } from '../core/http'
import { fold } from '../util/text'

export type EmailStatus = 'verified' | 'likely' | 'guessed' | 'unknown'
export type Person = {
  name: string
  title: string | null
  email: string | null
  emailStatus: EmailStatus
  linkedinUrl: string | null
  source: string
  confidence: number
}

/** One interface for every enrichment provider; each uses the user's own key. */
export interface Enricher {
  id: 'hunter' | 'apollo' | 'snov' | 'prospeo'
  searchPeople(domain: string, titles: string[], signal?: AbortSignal): Promise<Person[]>
  findEmail(first: string, last: string, domain: string, signal?: AbortSignal): Promise<Person | null>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const full = (first?: string | null, last?: string | null) => [first, last].filter(Boolean).join(' ').trim()

export function hunter(http: Http, key: string): Enricher {
  const status = (s?: string): EmailStatus => (s === 'valid' ? 'verified' : s === 'accept_all' ? 'likely' : 'unknown')
  type HunterEmail = { value: string; type: string; confidence: number; first_name: string | null; last_name: string | null; position: string | null; linkedin: string | null; verification?: { status?: string } }
  return {
    id: 'hunter',
    async searchPeople(domain, _titles, signal) {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&department=hr,management,it&type=personal&limit=20`
      const r = await http.getJson<{ data: { emails: HunterEmail[] } }>(url, { headers: { 'X-API-KEY': key }, ...(signal ? { signal } : {}) })
      return r.data.emails
        .filter((e) => e.first_name)
        .map((e) => ({ name: full(e.first_name, e.last_name), title: e.position, email: e.value, emailStatus: status(e.verification?.status), linkedinUrl: e.linkedin, source: 'hunter', confidence: e.confidence / 100 }))
    },
    async findEmail(first, last, domain, signal) {
      const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`
      const r = await http.getJson<{ data: { email: string | null; score: number; position: string | null; verification?: { status?: string } } }>(url, { headers: { 'X-API-KEY': key }, ...(signal ? { signal } : {}) })
      return r.data.email ? { name: full(first, last), title: r.data.position, email: r.data.email, emailStatus: status(r.data.verification?.status), linkedinUrl: null, source: 'hunter', confidence: r.data.score / 100 } : null
    },
  }
}

/** Apollo's search returns no emails; the top matches are enriched one by one (each uses a credit). */
export function apollo(http: Http, key: string): Enricher {
  const headers = { 'x-api-key': key }
  type ApolloPerson = { id: string; first_name: string; last_name?: string; last_name_obfuscated?: string; title: string | null; linkedin_url?: string | null; email?: string | null; email_status?: string | null }
  const match = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<ApolloPerson | null> => {
    const r = await http.getJson<{ person: ApolloPerson | null }>('https://api.apollo.io/api/v1/people/match', { method: 'POST', headers, json: body, ...(signal ? { signal } : {}) })
    return r.person
  }
  const toPerson = (p: ApolloPerson): Person => ({
    name: full(p.first_name, p.last_name),
    title: p.title,
    email: p.email ?? null,
    emailStatus: p.email_status === 'verified' ? 'verified' : p.email ? 'likely' : 'unknown',
    linkedinUrl: p.linkedin_url ?? null,
    source: 'apollo',
    confidence: p.email_status === 'verified' ? 0.9 : 0.6,
  })
  return {
    id: 'apollo',
    async searchPeople(domain, titles, signal) {
      const r = await http.getJson<{ people: ApolloPerson[] }>('https://api.apollo.io/api/v1/mixed_people/api_search', {
        method: 'POST',
        headers,
        json: { q_organization_domains_list: [domain], person_titles: titles, per_page: 10, page: 1 },
        ...(signal ? { signal } : {}),
      })
      const out: Person[] = []
      for (const p of r.people.slice(0, 3)) {
        const m = await match({ id: p.id }, signal).catch(() => null)
        if (m) out.push(toPerson(m))
      }
      return out
    },
    async findEmail(first, last, domain, signal) {
      const m = await match({ first_name: first, last_name: last, domain }, signal)
      return m?.email ? toPerson(m) : null
    },
  }
}

export function snov(http: Http, clientId: string, clientSecret: string): Enricher {
  let token: { value: string; until: number } | null = null
  const auth = async (signal?: AbortSignal) => {
    if (token && token.until > Date.now()) return token.value
    const r = await http.getJson<{ access_token: string; expires_in?: number }>('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      json: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
      ...(signal ? { signal } : {}),
    })
    token = { value: r.access_token, until: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 }
    return token.value
  }
  /** Snov's v2 endpoints are asynchronous: start a task, then poll for its result. */
  const task = async <T>(start: string, body: unknown, result: (hash: string) => string, signal?: AbortSignal): Promise<T | null> => {
    const headers = { Authorization: `Bearer ${await auth(signal)}` }
    const s = await http.getJson<{ meta?: { task_hash?: string }; data?: { task_hash?: string } }>(start, { method: 'POST', headers, json: body, ...(signal ? { signal } : {}) })
    const hash = s.meta?.task_hash ?? s.data?.task_hash
    if (!hash) return null
    for (let i = 0; i < 10; i++) {
      await sleep(2000)
      const r = await http.getJson<{ status?: string; data?: T }>(result(hash), { headers, ...(signal ? { signal } : {}) })
      if (r.status !== 'in_progress' && r.data) return r.data
    }
    return null
  }
  return {
    id: 'snov',
    async searchPeople(domain, titles, signal) {
      const data = await task<{ first_name: string; last_name: string; position: string | null; source_page: string | null }[]>(
        'https://api.snov.io/v2/domain-search/prospects/start',
        { domain, positions: titles.slice(0, 10) },
        (h) => `https://api.snov.io/v2/domain-search/prospects/result/${h}`,
        signal,
      )
      return (data ?? []).map((p) => ({ name: full(p.first_name, p.last_name), title: p.position, email: null, emailStatus: 'unknown' as const, linkedinUrl: p.source_page, source: 'snov', confidence: 0.6 }))
    },
    async findEmail(first, last, domain, signal) {
      const data = await task<{ people: string; result: { email: string; smtp_status: string }[] }[]>(
        'https://api.snov.io/v2/emails-by-domain-by-name/start',
        { rows: [{ first_name: first, last_name: last, domain }] },
        (h) => `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${h}`,
        signal,
      )
      const hit = data?.[0]?.result?.[0]
      return hit ? { name: full(first, last), title: null, email: hit.email, emailStatus: hit.smtp_status === 'valid' ? 'verified' : 'unknown', linkedinUrl: null, source: 'snov', confidence: hit.smtp_status === 'valid' ? 0.85 : 0.5 } : null
    },
  }
}

export function prospeo(http: Http, key: string): Enricher {
  return {
    id: 'prospeo',
    // Prospeo finds emails for people you already have; it does not list a company's staff here.
    searchPeople: async () => [],
    async findEmail(first, last, domain, signal) {
      try {
        const r = await http.getJson<{ error: boolean; person?: { full_name?: string; current_job_title?: string | null; email?: { email?: string; status?: string } } }>('https://api.prospeo.io/enrich-person', {
          method: 'POST',
          headers: { 'X-KEY': key },
          json: { data: { first_name: first, last_name: last, company_website: domain }, only_verified_email: true },
          ...(signal ? { signal } : {}),
        })
        const email = r.person?.email?.email
        if (r.error || !email || email.includes('*')) return null
        return { name: r.person?.full_name ?? full(first, last), title: r.person?.current_job_title ?? null, email, emailStatus: r.person?.email?.status === 'VERIFIED' ? 'verified' : 'likely', linkedinUrl: null, source: 'prospeo', confidence: 0.85 }
      } catch (err) {
        if (err instanceof HttpError && (err.status === 400 || err.status === 404)) return null
        throw err
      }
    },
  }
}

/** Enrichers the user has keys for, in the order they are tried. */
export function enrichers(http: Http, creds: Record<string, string>): Enricher[] {
  const out: Enricher[] = []
  if (creds['hunterKey']) out.push(hunter(http, creds['hunterKey']))
  if (creds['apolloKey']) out.push(apollo(http, creds['apolloKey']))
  if (creds['snovClientId'] && creds['snovClientSecret']) out.push(snov(http, creds['snovClientId'], creds['snovClientSecret']))
  if (creds['prospeoKey']) out.push(prospeo(http, creds['prospeoKey']))
  return out
}

// ---------------------------------------------------------------------------
// Email patterns. No SMTP probing: it is unreliable and gets addresses blocklisted.

const PATTERNS: { id: string; make: (f: string, l: string) => string }[] = [
  { id: 'first.last', make: (f, l) => `${f}.${l}` },
  { id: 'flast', make: (f, l) => `${f[0]}${l}` },
  { id: 'first', make: (f) => f },
  { id: 'firstlast', make: (f, l) => `${f}${l}` },
  { id: 'first_last', make: (f, l) => `${f}_${l}` },
  { id: 'f.last', make: (f, l) => `${f[0]}.${l}` },
  { id: 'firstl', make: (f, l) => `${f}${l[0]}` },
  { id: 'last', make: (_f, l) => l },
]

const localPart = (s: string) => fold(s).replace(/[^a-z]/g, '')

/** Which pattern produced the addresses we know at a domain, if one fits them all. */
export function inferPattern(known: { name: string; email: string }[]): string | null {
  const counts = new Map<string, number>()
  for (const k of known) {
    const [first, ...rest] = k.name.trim().split(/\s+/)
    const last = rest.at(-1)
    if (!first || !last) continue
    const local = k.email.split('@')[0]!.toLowerCase()
    for (const p of PATTERNS) if (p.make(localPart(first), localPart(last)) === local) counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return best ? best[0] : null
}

export function guessEmail(name: string, domain: string, pattern: string | null): string | null {
  const [first, ...rest] = name.trim().split(/\s+/)
  const last = rest.at(-1)
  if (!first || !last) return null
  const p = PATTERNS.find((x) => x.id === (pattern ?? 'first.last'))!
  return `${p.make(localPart(first), localPart(last))}@${domain}`
}

/** A domain that cannot receive mail makes every guess there useless. */
export async function hasMx(domain: string): Promise<boolean> {
  try {
    return (await resolveMx(domain)).length > 0
  } catch {
    return false
  }
}
