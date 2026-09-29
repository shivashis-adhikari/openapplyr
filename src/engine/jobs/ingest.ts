import { createHash } from 'node:crypto'
import type { JobLocation, Remote, Salary, Signal } from '../../shared/domain'
import { type Db, json } from '../core/db'
import { detectAts, isPlatformHost } from '../sources/detect'
import type { FetchResult, RawPosting } from '../sources/types'
import { htmlToMarkdown } from '../util/html'
import { cleanTitle, companyKey, contractTypeOf, employmentOf, isStaffingAgency, seniorityOf, titleKey } from './classify'
import { parseLocation } from './geo'
import { annualize, parseSalary } from './salary'
import { detectSignals } from './signals'

export type JobMeta = {
  remoteCountries: string[]
  remoteGlobal: boolean
  needsDetails: boolean
  department: string | null
  questions?: unknown
  [k: string]: unknown
}

export type NormalizedJob = {
  title: string
  titleNorm: string
  seniority: string | null
  employment: string | null
  contract: string | null
  remote: Remote
  locations: JobLocation[]
  locationText: string
  salary: Salary | null
  annualMin: number | null
  annualMax: number | null
  descriptionMd: string
  descriptionHtml: string | null
  url: string
  applyUrl: string | null
  applyAts: string | null
  postedAt: number | null
  meta: JobMeta
  hash: string
}

const REMOTE_IN_TEXT = /\b(this (is a |role is |position is )?(fully |100% )?remote (role|position|job)|(fully|100%) remote|work from anywhere|remote[- ]first company)\b/i

export function normalizePosting(p: RawPosting, sourceKind: string): NormalizedJob {
  const descriptionMd = p.descriptionHtml ? htmlToMarkdown(p.descriptionHtml) : (p.descriptionText ?? '').trim()
  let remoteHint = p.remoteHint
  if (!remoteHint && !p.locationText && REMOTE_IN_TEXT.test(descriptionMd.slice(0, 2000))) remoteHint = 'remote'
  const loc = parseLocation(p.locationText, { remote: remoteHint, country: p.countryHint ?? null })
  const salary = p.salary ?? parseSalary(descriptionMd)
  const ann = annualize(salary)
  const title = cleanTitle(p.title)
  const employment = employmentOf(p.employmentHint, descriptionMd)
  const contract = contractTypeOf(`${p.employmentHint ?? ''}\n${descriptionMd}`)
  const applyUrl = p.applyUrl ?? null
  const ats = detectAts(applyUrl ?? p.url)?.ats ?? (['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'recruitee', 'workable'].includes(sourceKind) ? sourceKind : null)
  const meta: JobMeta = {
    ...(p.meta ?? {}),
    remoteCountries: loc.remoteCountries,
    remoteGlobal: loc.remoteGlobal,
    needsDetails: !!p.needsDetails,
    department: p.department ?? null,
    ...(p.questions !== undefined ? { questions: p.questions } : {}),
  }
  const hash = createHash('sha1')
    .update([title, descriptionMd, p.locationText, JSON.stringify(salary), applyUrl ?? ''].join('\u0000'))
    .digest('hex')
  return {
    title,
    titleNorm: titleKey(title),
    seniority: seniorityOf(title),
    employment,
    contract,
    remote: loc.remote,
    locations: loc.locations,
    locationText: p.locationText,
    salary,
    annualMin: ann.min,
    annualMax: ann.max,
    descriptionMd,
    descriptionHtml: p.descriptionHtml ?? null,
    url: p.url,
    applyUrl,
    applyAts: ats,
    postedAt: p.postedAt ?? null,
    meta,
    hash,
  }
}

export function upsertCompany(db: Db, name: string, opts: { domain?: string | null; ats?: string | null; now: number }): number | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  const key = companyKey(clean)
  if (!key) return null
  const existing = db.get<{ id: number; domain: string | null; ats: string | null }>('SELECT id, domain, ats FROM companies WHERE name_norm = ?', [key])
  if (existing) {
    if ((!existing.domain && opts.domain) || (!existing.ats && opts.ats)) {
      db.run('UPDATE companies SET domain = COALESCE(domain, ?), ats = COALESCE(ats, ?) WHERE id = ?', [opts.domain ?? null, opts.ats ?? null, existing.id])
    }
    return existing.id
  }
  return db.run('INSERT INTO companies (name, name_norm, domain, ats, staffing, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    clean,
    key,
    opts.domain ?? null,
    opts.ats ?? null,
    isStaffingAgency(clean) ? 1 : 0,
    opts.now,
  ]).lastInsertRowid
}

function employerDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^(www|careers|jobs|boards)\./, '')
    return isPlatformHost(host) ? null : host
  } catch {
    return null
  }
}

/** Two postings are the same role if the places overlap, or both are remote. */
function sameWhere(a: { remote: string; locations: JobLocation[] }, b: { remote: string; locations: JobLocation[] }): boolean {
  if (a.remote === 'remote' && b.remote === 'remote') return true
  if (!a.locations.length || !b.locations.length) return a.remote === b.remote
  return a.locations.some((x) => b.locations.some((y) => (x.city && x.city === y.city) || (!x.city && !y.city && x.country === y.country)))
}

export type IngestResult = { inserted: number[]; updated: number[]; reopened: number; closed: number }

type JobRowLite = { id: number; hash: string; closed_at: number | null; group_id: number | null; repost_count: number; meta: string; description_md: string }

/**
 * Stores a fetch result. New postings are grouped with earlier sightings of the same role (same company,
 * title and place within 45 days) so reposts and aggregator copies are recognized. When the source listed
 * its whole board, postings that disappeared are marked closed.
 */
export function ingest(db: Db, source: { id: number; kind: string }, result: FetchResult, now: number): IngestResult {
  const out: IngestResult = { inserted: [], updated: [], reopened: 0, closed: 0 }
  db.tx(() => {
    for (const p of result.postings) {
      if (!p.externalId || !p.title) continue
      const n = normalizePosting(p, source.kind)
      const companyName = (p.company || result.companyName || '').trim() || 'Unknown company'
      const companyId = upsertCompany(db, companyName, { domain: employerDomain(p.url), ats: n.applyAts, now })
      const existing = db.get<JobRowLite>('SELECT id, hash, closed_at, group_id, repost_count, meta, description_md FROM jobs WHERE source_kind = ? AND external_id = ?', [
        source.kind,
        p.externalId,
      ])
      if (existing) {
        if (existing.closed_at) out.reopened++
        if (existing.hash !== n.hash) {
          // A listing-only refresh must not wipe a description fetched earlier.
          const oldMeta = json.parse<JobMeta>(existing.meta, {} as JobMeta)
          const keepDescription = n.meta.needsDetails && !oldMeta.needsDetails && existing.description_md
          db.run(
            `UPDATE jobs SET title = ?, title_norm = ?, seniority = ?, employment_type = ?, contract_type = ?, remote = ?, locations = ?,
               location_text = ?, salary = ?, salary_annual_min = ?, salary_annual_max = ?, salary_currency = ?, url = ?, apply_url = COALESCE(?, apply_url),
               apply_ats = COALESCE(?, apply_ats), description_md = ?, description_html = ?, posted_at = COALESCE(?, posted_at), meta = ?, hash = ?,
               last_seen_at = ?, closed_at = NULL, updated_at = ?
             WHERE id = ?`,
            [
              n.title,
              n.titleNorm,
              n.seniority,
              n.employment,
              n.contract,
              n.remote,
              JSON.stringify(n.locations),
              n.locationText,
              n.salary ? JSON.stringify(n.salary) : null,
              n.annualMin,
              n.annualMax,
              n.salary?.currency ?? null,
              n.url,
              n.applyUrl,
              n.applyAts,
              keepDescription ? existing.description_md : n.descriptionMd,
              keepDescription ? null : n.descriptionHtml,
              n.postedAt,
              JSON.stringify(keepDescription ? { ...n.meta, needsDetails: false } : n.meta),
              n.hash,
              now,
              now,
              existing.id,
            ],
          )
          out.updated.push(existing.id)
        } else {
          db.run('UPDATE jobs SET last_seen_at = ?, closed_at = NULL WHERE id = ?', [now, existing.id])
        }
        continue
      }
      const id = db.run(
        `INSERT INTO jobs (source_id, source_kind, external_id, company_id, company_name, title, title_norm, seniority, employment_type, contract_type,
           remote, locations, location_text, salary, salary_annual_min, salary_annual_max, salary_currency, url, apply_url, apply_ats,
           description_md, description_html, posted_at, first_seen_at, last_seen_at, meta, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source.id > 0 ? source.id : null,
          source.kind,
          p.externalId,
          companyId,
          companyName,
          n.title,
          n.titleNorm,
          n.seniority,
          n.employment,
          n.contract,
          n.remote,
          JSON.stringify(n.locations),
          n.locationText,
          n.salary ? JSON.stringify(n.salary) : null,
          n.annualMin,
          n.annualMax,
          n.salary?.currency ?? null,
          n.url,
          n.applyUrl,
          n.applyAts,
          n.descriptionMd,
          n.descriptionHtml,
          n.postedAt,
          now,
          now,
          JSON.stringify(n.meta),
          n.hash,
          now,
        ],
      ).lastInsertRowid
      // Group with an earlier sighting of the same role.
      const candidates = companyId
        ? db.all<{ id: number; group_id: number | null; repost_count: number; source_kind: string; remote: string; locations: string }>(
            `SELECT id, group_id, repost_count, source_kind, remote, locations FROM jobs
             WHERE company_id = ? AND title_norm = ? AND id != ? AND first_seen_at >= ? ORDER BY first_seen_at ASC LIMIT 20`,
            [companyId, n.titleNorm, id, now - 45 * 86_400_000],
          )
        : []
      const match = candidates.find((c) => sameWhere({ remote: c.remote, locations: json.parse(c.locations, []) }, n))
      if (match) {
        const repost = match.source_kind === source.kind ? match.repost_count + 1 : match.repost_count
        db.run('UPDATE jobs SET group_id = ?, repost_count = ? WHERE id = ?', [match.group_id ?? match.id, repost, id])
        if (repost !== match.repost_count) db.run('UPDATE jobs SET repost_count = ? WHERE group_id = ?', [repost, match.group_id ?? match.id])
      } else {
        db.run('UPDATE jobs SET group_id = ? WHERE id = ?', [id, id])
      }
      out.inserted.push(id)
    }
    if (result.complete) {
      out.closed = db.run('UPDATE jobs SET closed_at = ? WHERE source_id = ? AND closed_at IS NULL AND last_seen_at < ?', [now, source.id, now]).changes
    }
    for (const id of [...out.inserted, ...out.updated]) refreshSignals(db, id, now)
    db.run('UPDATE sources SET job_count = (SELECT COUNT(*) FROM jobs WHERE source_id = ? AND closed_at IS NULL) WHERE id = ?', [source.id, source.id])
  })
  return out
}

export function refreshSignals(db: Db, jobId: number, now: number): Signal[] {
  const j = db.get<{ description_md: string; company_name: string; posted_at: number | null; repost_count: number; domain: string | null; staffing: number | null; h1b: string | null }>(
    `SELECT j.description_md, j.company_name, j.posted_at, j.repost_count, c.domain, c.staffing, c.h1b
     FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
    [jobId],
  )
  if (!j) return []
  const signals = detectSignals({
    description: j.description_md,
    company: j.company_name,
    companyDomain: j.domain,
    postedAt: j.posted_at,
    repostCount: j.repost_count,
    staffing: !!j.staffing || isStaffingAgency(j.company_name, j.description_md),
    now,
  })
  const h1b = json.parse<{ approvals: number; years: string } | null>(j.h1b, null)
  if (h1b && h1b.approvals > 0) signals.push({ kind: 'h1b_history', severity: 'info', label: `${h1b.approvals} H-1B approvals (${h1b.years})`, detail: 'From USCIS H-1B Employer Data Hub.' })
  db.run('UPDATE jobs SET signals = ? WHERE id = ?', [JSON.stringify(signals), jobId])
  return signals
}
