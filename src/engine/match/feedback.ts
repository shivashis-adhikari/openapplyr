import { z } from 'zod'
import type { HuntSuggestion } from '../../shared/api/jobs'
import type { Db } from '../core/db'
import { block, definePrompt } from '../ai/prompt'
import { titleKey } from '../jobs/classify'
import { getHunt } from './hunts'

const STOP = new Set(['senior', 'junior', 'staff', 'lead', 'principal', 'engineer', 'developer', 'manager', 'the', 'and', 'of', 'for', 'with', 'i', 'ii', 'iii', '-', '&'])

/**
 * Turns repeated skip reasons into proposed hunt changes. Nothing changes until the user accepts one.
 * A suggestion needs at least five similar skips in the last 30 days.
 */
export function huntSuggestions(db: Db, huntId: number, now: number): HuntSuggestion[] {
  const hunt = getHunt(db, huntId)
  const skips = db.all<{ reason: string | null; title: string; company_name: string; seniority: string | null }>(
    `SELECT f.reason, j.title, j.company_name, j.seniority FROM feedback f JOIN jobs j ON j.id = f.job_id
     WHERE f.action = 'skip' AND (f.hunt_id = ? OR f.hunt_id IS NULL) AND f.created_at > ?`,
    [huntId, now - 30 * 86_400_000],
  )
  const out: HuntSuggestion[] = []
  const levels = new Map<string, number>()
  for (const s of skips) if (s.reason === 'level' && s.seniority) levels.set(s.seniority, (levels.get(s.seniority) ?? 0) + 1)
  for (const [level, n] of levels) {
    if (n < 5) continue
    const current = hunt.config.seniority.length ? hunt.config.seniority : ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive']
    out.push({ id: `level:${level}`, text: `You skipped ${n} ${level}-level jobs for their level. Stop showing ${level} roles?`, patch: { seniority: current.filter((l) => l !== level) as never } })
  }
  const companies = new Map<string, number>()
  for (const s of skips) if (s.reason === 'company') companies.set(s.company_name, (companies.get(s.company_name) ?? 0) + 1)
  const repeated = [...companies].filter(([, n]) => n >= 2).map(([c]) => c)
  if (repeated.length && skips.filter((s) => s.reason === 'company').length >= 5) {
    out.push({ id: 'companies', text: `You skipped ${repeated.join(', ')} more than once. Exclude ${repeated.length === 1 ? 'it' : 'them'}?`, patch: { companiesExclude: [...hunt.config.companiesExclude, ...repeated] } })
  }
  const words = new Map<string, number>()
  const wanted = new Set(hunt.config.titles.flatMap((t) => titleKey(t).split(' ')))
  for (const s of skips.filter((x) => x.reason === 'role' || x.reason === 'domain')) {
    for (const w of new Set(titleKey(s.title).split(/[\s,/()]+/))) if (w.length > 2 && !STOP.has(w) && !wanted.has(w)) words.set(w, (words.get(w) ?? 0) + 1)
  }
  for (const [w, n] of [...words].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    if (n < 5 || hunt.config.excludeKeywords.includes(w)) continue
    out.push({ id: `word:${w}`, text: `${n} jobs you skipped had "${w}" in the title. Exclude titles containing "${w}"?`, patch: { excludeKeywords: [...hunt.config.excludeKeywords, w] } })
  }
  return out
}

export const titleIdeasPrompt = definePrompt<{ titles: string[] }, { titles: string[] }>({
  id: 'hunts.titles',
  version: 1,
  role: 'fast',
  system: 'You suggest alternative job titles that employers use for the same work, so a job search does not miss postings.',
  describe: 'Alternative job titles.',
  maxOutputTokens: 400,
  cache: true,
  user: ({ titles }) =>
    block(
      'instructions',
      `The person searches for: ${titles.join('; ')}.\nList up to 8 other titles employers commonly use for the same work at the same level. ` +
        'Do not include more senior or junior versions, and do not repeat the titles above.',
    ),
  schema: z.object({ titles: z.array(z.string().min(2).max(60)).max(8) }),
  mock: ({ titles }) => {
    const map: Record<string, string[]> = {
      backend: ['Server Engineer', 'API Engineer', 'Platform Engineer'],
      frontend: ['UI Engineer', 'Web Engineer', 'React Developer'],
      'full stack': ['Fullstack Developer', 'Software Engineer'],
      data: ['Analytics Engineer', 'Data Platform Engineer'],
      designer: ['UX Designer', 'UI/UX Designer', 'Interaction Designer'],
      product: ['Product Owner', 'Technical Product Manager'],
    }
    const out = new Set<string>()
    for (const t of titles) for (const [k, v] of Object.entries(map)) if (t.toLowerCase().includes(k)) v.forEach((x) => out.add(x))
    return { titles: [...out].filter((x) => !titles.some((t) => t.toLowerCase() === x.toLowerCase())).slice(0, 8) }
  },
})
