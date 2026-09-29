import type { Judgment, Profile } from '../../shared/domain'
import { json } from '../core/db'
import type { Db } from '../core/db'
import { titleKey } from '../jobs/classify'
import { findTerms } from '../jobs/terms'
import { profileDigest } from '../profile/digest'

export type GapRow = { term: string; missing: number; mustHave: number; jobs: number }

/**
 * Requirements the user is missing across a hunt's recent matches, most common first:
 * "Kubernetes missing in 23 of 60 jobs". Counted per job, from the model's per-requirement verdicts.
 */
export function skillsGap(db: Db, huntId: number | null, since: number): { jobs: number; rows: GapRow[] } {
  const rows = db.all<{ job_id: number; judgment: string }>(
    `SELECT job_id, judgment FROM job_scores WHERE stage = 'judged' AND judgment IS NOT NULL AND created_at >= ? ${huntId ? 'AND hunt_id = ?' : ''}`,
    huntId ? [since, huntId] : [since],
  )
  const seenJobs = new Set<number>()
  const counts = new Map<string, { jobs: Set<number>; must: Set<number> }>()
  for (const r of rows) {
    seenJobs.add(r.job_id)
    const j = json.parse<Judgment | null>(r.judgment, null)
    for (const req of j?.requirements ?? []) {
      if (req.verdict !== 'missing') continue
      for (const term of findTerms(req.text)) {
        const c = counts.get(term) ?? { jobs: new Set(), must: new Set() }
        c.jobs.add(r.job_id)
        if (req.kind === 'must') c.must.add(r.job_id)
        counts.set(term, c)
      }
    }
  }
  const out = [...counts.entries()].map(([term, c]) => ({ term, missing: c.jobs.size, mustHave: c.must.size, jobs: seenJobs.size }))
  return { jobs: seenJobs.size, rows: out.sort((a, b) => b.missing - a.missing || b.mustHave - a.mustHave).slice(0, 30) }
}

export type AdjacentTitle = { title: string; postings: number; overlap: number; have: string[]; missing: string[] }

/**
 * Titles close to the user's background, from postings already in the local database: for each title,
 * the tools its postings ask for most, and how many of those the profile shows.
 */
export function careerExplorer(db: Db, profile: Profile, since: number, exclude: string[]): AdjacentTitle[] {
  const mine = new Set(findTerms(profileDigest(profile)))
  const skip = new Set(exclude.map(titleKey))
  const groups = new Map<string, { title: string; postings: number; terms: Map<string, number> }>()
  for (const j of db.all<{ title: string; description_md: string }>('SELECT title, description_md FROM jobs WHERE first_seen_at >= ? AND closed_at IS NULL LIMIT 20000', [since])) {
    const key = titleKey(j.title)
    if (!key || skip.has(key)) continue
    const g = groups.get(key) ?? { title: j.title, postings: 0, terms: new Map() }
    g.postings++
    for (const t of new Set(findTerms(j.description_md))) g.terms.set(t, (g.terms.get(t) ?? 0) + 1)
    groups.set(key, g)
  }
  const out: AdjacentTitle[] = []
  for (const g of groups.values()) {
    if (g.postings < 3) continue
    // Terms at least a third of this title's postings ask for.
    const common = [...g.terms.entries()].filter(([, n]) => n >= g.postings / 3).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t)
    if (common.length < 3) continue
    const have = common.filter((t) => mine.has(t))
    out.push({ title: g.title, postings: g.postings, overlap: have.length / common.length, have, missing: common.filter((t) => !mine.has(t)) })
  }
  return out.sort((a, b) => b.overlap * Math.log2(1 + b.postings) - a.overlap * Math.log2(1 + a.postings)).slice(0, 15)
}

export type Offer = {
  company: string
  title: string
  currency: string
  base: number
  bonusPct: number
  signOn: number
  equityValue: number
  vestingYears: number
  cliffMonths: number
  benefits: string
  location: string
  deadline: string
}

/** First-year and average yearly pay over the vesting period, from the numbers the user entered. */
export function offerTotals(o: Offer): { firstYear: number; averageYear: number } {
  const bonus = (o.base * o.bonusPct) / 100
  const equityYear = o.vestingYears > 0 ? o.equityValue / o.vestingYears : 0
  const firstYearEquity = o.cliffMonths > 12 ? 0 : equityYear
  const years = Math.max(1, o.vestingYears)
  return { firstYear: Math.round(o.base + bonus + firstYearEquity + o.signOn), averageYear: Math.round(o.base + bonus + equityYear + o.signOn / years) }
}
