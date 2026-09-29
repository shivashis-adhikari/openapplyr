import { z } from 'zod'
import { block, definePrompt, untrusted } from '../ai/prompt'
import { errorMessage } from '../core/errors'
import type { Http } from '../core/http'
import type { Ctx } from '../engine'
import { credentials } from '../integrations'
import { cleanTitle } from '../jobs/classify'
import type { Services } from '../services'
import { isPlatformHost } from '../sources/detect'
import { htmlToText } from '../util/html'
import { type EmailStatus, type Person, enrichers, guessEmail, hasMx, inferPattern } from './enrich'

export type Relation = 'recruiter' | 'hiring_manager' | 'team' | 'generic' | 'other'

/** "careers.acme.co.uk" -> "acme.co.uk"; "jobs.acme.com" -> "acme.com". */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.')
  const twoLevel = parts.length >= 3 && parts.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu|ltd|plc)$/.test(parts.at(-2)!)
  return parts.slice(twoLevel ? -3 : -2).join('.')
}

const GENERIC_LOCAL = /^(jobs|careers|career|recruiting|recruitment|talent|hr|people|hiring|apply|work|joinus|join)$/i

export function relationOf(title: string | null, email: string | null): Relation {
  if (email && GENERIC_LOCAL.test(email.split('@')[0] ?? '')) return 'generic'
  const t = (title ?? '').toLowerCase()
  if (/recruit|talent|sourc|people partner|hr business partner/.test(t)) return 'recruiter'
  if (/\b(manager|head|director|lead|vp|vice president|chief|founder|cto|ceo)\b/.test(t)) return 'hiring_manager'
  if (t) return 'team'
  return 'other'
}

const RELATION_WEIGHT: Record<Relation, number> = { recruiter: 3, hiring_manager: 3, team: 2, generic: 1, other: 1 }
const STATUS_WEIGHT: Record<EmailStatus, number> = { verified: 1, likely: 0.8, guessed: 0.5, unknown: 0.3 }
export const rank = (c: { relation: Relation; emailStatus: EmailStatus; confidence: number; email: string | null }) =>
  c.email ? RELATION_WEIGHT[c.relation] * STATUS_WEIGHT[c.emailStatus] + c.confidence : 0

/** The likely hiring manager's title for a role: "Senior Backend Engineer" -> "Engineering Manager". */
export function managerTitles(jobTitle: string): string[] {
  const t = cleanTitle(jobTitle).toLowerCase()
  if (/engineer|developer|sre|devops|platform/.test(t)) return ['Engineering Manager', 'Head of Engineering', 'Director of Engineering']
  if (/data|analyst|scientist|machine learning/.test(t)) return ['Head of Data', 'Data Science Manager', 'Analytics Manager']
  if (/design/.test(t)) return ['Design Manager', 'Head of Design']
  if (/product/.test(t)) return ['Director of Product', 'Head of Product', 'Group Product Manager']
  if (/market/.test(t)) return ['Head of Marketing', 'Marketing Director']
  if (/sales|account/.test(t)) return ['Sales Director', 'Head of Sales']
  return [`${cleanTitle(jobTitle)} Manager`]
}

const RECRUITER_TITLES = ['Recruiter', 'Technical Recruiter', 'Talent Acquisition', 'Talent Partner']

/** Emails printed in the posting itself (often a recruiter or a jobs inbox). */
export function postingEmails(text: string): string[] {
  return [...new Set((text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []).map((e) => e.toLowerCase()))].filter((e) => !/\.(png|jpg|gif)$|noreply|no-reply|example\./.test(e))
}

/** Minimal robots.txt check for "User-agent: *": the longest matching Allow or Disallow wins. */
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false
  let best: { len: number; allow: boolean } = { len: -1, allow: true }
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const [key, value] = [m[1]!.toLowerCase(), m[2]!.trim()]
    if (key === 'user-agent') applies = value === '*'
    else if (applies && (key === 'allow' || key === 'disallow') && value && path.startsWith(value.replace(/\*.*$/, '')) && value.length > best.len) best = { len: value.length, allow: key === 'allow' }
  }
  return best.allow
}

const PeopleSchema = z.object({ people: z.array(z.object({ name: z.string(), title: z.string().nullable(), email: z.string().nullable() })).max(30) })

export const extractPeoplePrompt = definePrompt<{ company: string; pages: string }, z.infer<typeof PeopleSchema>>({
  id: 'contacts.extract',
  version: 1,
  role: 'fast',
  system: 'You list the people named on a company\'s own web pages, with their job titles, exactly as written. You never guess names or emails.',
  describe: 'People named on the pages.',
  maxOutputTokens: 1200,
  user: (i) =>
    [
      untrusted(`${i.company} web pages`, i.pages),
      block('instructions', 'List each person with a name and a job title that the pages state. Include an email only when the page shows it. At most 30.'),
    ].join('\n\n'),
  schema: PeopleSchema,
  mock: () => ({ people: [] }),
})

export async function companyPages(http: Http, domain: string, signal?: AbortSignal): Promise<string> {
  const base = `https://${domain}`
  const robots = await http.getText(`${base}/robots.txt`, { as: 'page', timeoutMs: 10_000, retries: 0, ...(signal ? { signal } : {}) }).then((r) => (r.status === 200 ? r.text : ''), () => '')
  const texts: string[] = []
  for (const path of ['/about', '/team', '/about-us', '/company', '/people', '/leadership']) {
    if (!robotsAllows(robots, path)) continue
    try {
      const r = await http.getText(`${base}${path}`, { as: 'page', timeoutMs: 15_000, retries: 0, maxBytes: 2_000_000, ...(signal ? { signal } : {}) })
      if (r.status === 200) texts.push(`# ${path}\n${htmlToText(r.text).slice(0, 6000)}`)
    } catch {
      /* missing page */
    }
    if (texts.join('').length > 15_000) break
  }
  return texts.join('\n\n')
}

export type Candidate = Person & { relation: Relation }

/**
 * Finds people to contact about an application, best first: the posting, the company's own
 * pages, enrichment providers with the user's keys, then address patterns checked against MX records.
 * Stops as soon as there are enough good contacts.
 */
export async function discoverContacts(ctx: Ctx, s: Services, applicationId: number, signal?: AbortSignal): Promise<number[]> {
  const { db } = ctx
  const app = db.get<{ job_id: number | null; company_id: number | null; company_name: string; title: string; url: string | null }>('SELECT job_id, company_id, company_name, title, url FROM applications WHERE id = ?', [applicationId])
  if (!app) return []
  const job = app.job_id ? db.get<{ description_md: string; url: string }>('SELECT description_md, url FROM jobs WHERE id = ?', [app.job_id]) : undefined
  const company = app.company_id ? db.get<{ domain: string | null }>('SELECT domain FROM companies WHERE id = ?', [app.company_id]) : undefined
  const urlHost = (() => {
    try {
      const h = new URL(job?.url ?? app.url ?? '').hostname.replace(/^www\./, '')
      return isPlatformHost(h) ? null : baseDomain(h)
    } catch {
      return null
    }
  })()
  const domain = company?.domain?.replace(/^www\./, '') ?? urlHost
  const found: Candidate[] = []
  const add = (p: Person) => {
    if (p.email && found.some((f) => f.email === p.email)) return
    if (!p.email && found.some((f) => f.name.toLowerCase() === p.name.toLowerCase())) return
    found.push({ ...p, relation: relationOf(p.title, p.email) })
  }
  const enough = () => found.filter((f) => f.email && f.emailStatus !== 'guessed' && (f.relation === 'recruiter' || f.relation === 'hiring_manager')).length >= 2

  for (const email of postingEmails(job?.description_md ?? '')) {
    const local = email.split('@')[0]!
    add({ name: GENERIC_LOCAL.test(local) ? `${app.company_name} recruiting` : local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), title: null, email, emailStatus: 'likely', linkedinUrl: null, source: 'posting', confidence: 0.8 })
  }

  if (domain && !enough() && !s.ai.isMock()) {
    try {
      const pages = await companyPages(ctx.http, domain, signal)
      if (pages) {
        const r = await s.ai.structured(extractPeoplePrompt, { company: app.company_name, pages }, { task: 'Find contacts', signal })
        // Keep only names the pages actually contain.
        for (const p of r.people) if (pages.includes(p.name)) add({ name: p.name, title: p.title, email: p.email && pages.includes(p.email) ? p.email.toLowerCase() : null, emailStatus: p.email ? 'likely' : 'unknown', linkedinUrl: null, source: 'website', confidence: 0.6 })
      }
    } catch (err) {
      ctx.log.warn('company pages failed', { domain, err: errorMessage(err) })
    }
  }

  const providers = enrichers(ctx.http, credentials(ctx))
  if (domain) {
    for (const e of providers) {
      if (enough()) break
      try {
        for (const p of await e.searchPeople(domain, [...RECRUITER_TITLES, ...managerTitles(app.title)], signal)) add(p)
      } catch (err) {
        ctx.log.warn('enrichment failed', { provider: e.id, err: errorMessage(err) })
      }
    }
    // Emails for the best people still missing one: providers first, then the domain's pattern.
    const known = db.all<{ name: string; email: string }>('SELECT name, email FROM contacts WHERE email LIKE ?', [`%@${domain}`]).concat(found.filter((f): f is Candidate & { email: string } => !!f.email && f.email.endsWith(`@${domain}`)))
    const pattern = inferPattern(known)
    const mx = await hasMx(domain)
    for (const f of found.filter((x) => !x.email && x.relation !== 'other').slice(0, 4)) {
      const [first, ...rest] = f.name.split(/\s+/)
      const last = rest.at(-1)
      if (!first || !last) continue
      for (const e of providers) {
        const hit = await e.findEmail(first, last, domain, signal).catch(() => null)
        if (hit?.email) {
          Object.assign(f, { email: hit.email.toLowerCase(), emailStatus: hit.emailStatus, source: `${f.source}+${e.id}` })
          break
        }
      }
      if (!f.email && mx) {
        const guess = guessEmail(f.name, domain, pattern)
        if (guess) Object.assign(f, { email: guess, emailStatus: 'guessed' as const, confidence: pattern ? 0.5 : 0.3 })
      }
    }
  }

  const ids: number[] = []
  for (const c of found.filter((x) => x.email).sort((a, b) => rank(b) - rank(a)).slice(0, 6)) {
    const existing = db.get<{ id: number; do_not_contact: number }>('SELECT id, do_not_contact FROM contacts WHERE lower(email) = ?', [c.email!])
    if (existing) {
      if (!existing.do_not_contact) ids.push(existing.id)
      continue
    }
    ids.push(
      db.run(
        'INSERT INTO contacts (company_id, company_name, name, title, relation, email, email_status, linkedin_url, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [app.company_id, app.company_name, c.name, c.title, c.relation, c.email, c.emailStatus, c.linkedinUrl, c.source, c.confidence, ctx.now()],
      ).lastInsertRowid,
    )
  }
  ctx.bus.changed('contacts')
  return ids
}
