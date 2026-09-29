import type { FactLockIssue, Profile, ResumeContent, ResumeLine } from '../../shared/domain'
import { canonicalTerm, findTerms } from '../jobs/terms'
import { yearsOfExperience } from '../profile/store'
import { fold } from '../util/text'

const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', hundred: '100', dozen: '12', twice: '2', double: '2', triple: '3', half: '50',
}
const UNIT: Record<string, string> = {
  '%': '%', percent: '%', pct: '%', k: 'k', thousand: 'k', m: 'm', mm: 'm', million: 'm', b: 'b', bn: 'b', billion: 'b', x: 'x', '×': 'x', times: 'x',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h', h: 'h', minute: 'min', minutes: 'min', min: 'min', mins: 'min', second: 's', seconds: 's', sec: 's', ms: 'ms',
  day: 'd', days: 'd', week: 'wk', weeks: 'wk', month: 'mo', months: 'mo', year: 'y', years: 'y', yr: 'y', yrs: 'y',
}

/**
 * Numbers as (value, unit) pairs, normalized so "40%", "40 percent" and "forty percent" are the same claim,
 * and "$1.2M" equals "1.2 million". Years that look like dates (1990-2039) are ignored: dates are copied by code.
 */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>()
  let t = ` ${text.toLowerCase()} `
  for (const [w, d] of Object.entries(WORD_NUMBERS)) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), d)
  const re = /([$€£₹])?\s?(\d+(?:[.,]\d+)*)\s?(%|percent|pct|k|thousand|mm?|million|bn?|billion|x|×|times|hours?|hrs?|h|minutes?|mins?|min|seconds?|secs?|ms|days?|weeks?|months?|years?|yrs?)?(?![\w])/g
  for (const m of t.matchAll(re)) {
    const raw = m[2]!
    // "1,200" is 1200; "1.5" stays a decimal; "12,00,000" (Indian grouping) is 1200000.
    const value = /^\d{1,3}(,\d{2,3})+$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/,/g, '.')
    const n = Number(value)
    if (!Number.isFinite(n)) continue
    if (!m[1] && !m[3] && Number.isInteger(n) && n >= 1990 && n <= 2039) continue
    const unit = m[3] ? (UNIT[m[3]] ?? m[3]) : ''
    out.add(`${n}${unit}`)
    if (unit === '') out.add(`${n}`)
  }
  return out
}

/** Acronyms and dotted or CamelCase tokens that look like named things (AWS, S3, Node.js, GraphQL). */
const GENERIC = new Set(['API', 'APIs', 'UI', 'UX', 'QA', 'KPI', 'KPIs', 'OKR', 'OKRs', 'SLA', 'SLAs', 'SLO', 'SLOs', 'ROI', 'B2B', 'B2C', 'SaaS', 'US', 'USA', 'UK', 'EU', 'CEO', 'CTO', 'CFO', 'COO', 'VP', 'HR', 'IT', 'PM', 'PR', 'MVP', 'R&D', 'P&L', 'FTE', 'FTEs', 'Q1', 'Q2', 'Q3', 'Q4', 'ID', 'IDs', 'PhD', 'MBA', 'BSc', 'MSc', 'BA', 'MA', 'BS', 'MS', 'NPS', 'ARR', 'MRR', 'CRM', 'ERP', 'SEO', 'SEM', 'OK'])
function namedTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\b([A-Z]{2,}[a-z]*s?|[A-Z][a-z]+[A-Z][A-Za-z]+|[A-Za-z]+\.(?:js|io|ai|net|py)|[A-Z][A-Za-z]*\d[A-Za-z0-9]*)\b/g)) {
    const tok = m[1]!
    if (!GENERIC.has(tok)) out.push(tok)
  }
  return out
}

type Source = { id: string; text: string }

export type FactLockOptions = { now?: Date }

/**
 * Checks a generated resume against the profile it was built from:
 * - every line cites at least one fact from the same role or project;
 * - every number appears in the cited facts;
 * - every named technology, tool or acronym appears in the cited facts or the profile's skills;
 * - employers, titles and dates match the profile exactly.
 * It reports; the tailoring step decides whether to retry or fall back to the original text.
 */
export function factLock(content: ResumeContent, profile: Profile, o: FactLockOptions = {}): FactLockIssue[] {
  const issues: FactLockIssue[] = []
  const skillCanon = new Set(profile.skills.map((s) => canonicalTerm(s.name) ?? fold(s.name)))
  const allText = [
    profile.basics.headline,
    profile.basics.summary,
    ...profile.work.flatMap((w) => [w.title, w.company, w.summary, ...w.bullets.map((b) => b.text), ...w.skills]),
    ...profile.projects.flatMap((p) => [p.name, p.description, ...p.bullets.map((b) => b.text), ...p.skills]),
    ...profile.education.flatMap((e) => [e.degree, e.field, e.institution]),
    ...profile.certifications.map((c) => c.name),
    ...profile.skills.map((s) => s.name),
  ].join('\n')
  const allFolded = fold(allText)
  const allTerms = new Set(findTerms(allText))

  const checkLine = (location: string, line: ResumeLine, sources: Source[], scopeSkills: string[]) => {
    const cited = sources.filter((s) => line.sourceIds.includes(s.id))
    if (!line.sourceIds.length || cited.length !== line.sourceIds.length) {
      issues.push({ location, kind: 'citation', token: line.sourceIds.join(',') || '(none)', message: 'This line does not cite a fact from the same role.' })
      return
    }
    const srcText = cited.map((s) => s.text).join('\n')
    const srcNumbers = numbersIn(srcText)
    for (const n of numbersIn(line.text)) {
      if (!srcNumbers.has(n)) issues.push({ location, kind: 'number', token: n, message: `The number ${n} is not in the cited fact.` })
    }
    const srcTerms = new Set([...findTerms(srcText), ...scopeSkills.map((s) => canonicalTerm(s) ?? s)])
    for (const term of findTerms(line.text)) {
      if (!srcTerms.has(term) && !skillCanon.has(term)) issues.push({ location, kind: 'entity', token: term, message: `"${term}" is not in the cited fact or your skills.` })
    }
    const srcFolded = fold(srcText)
    for (const tok of namedTokens(line.text)) {
      const canon = canonicalTerm(tok)
      if (canon && (srcTerms.has(canon) || skillCanon.has(canon))) continue
      if (!srcFolded.includes(fold(tok)) && !skillCanon.has(fold(tok))) issues.push({ location, kind: 'entity', token: tok, message: `"${tok}" is not in the cited fact.` })
    }
  }

  for (const [i, w] of content.work.entries()) {
    const src = profile.work.find((x) => x.id === w.workId)
    if (!src) {
      issues.push({ location: `work.${i}`, kind: 'structure', token: w.company, message: 'This role is not in your profile.' })
      continue
    }
    if (src.company !== w.company || src.title !== w.title || src.start !== w.start || (src.end ?? null) !== (w.end ?? null)) {
      issues.push({ location: `work.${i}`, kind: 'structure', token: `${w.title} @ ${w.company}`, message: 'Employer, title or dates differ from your profile.' })
    }
    const sources: Source[] = [...src.bullets.map((b) => ({ id: b.id, text: b.text })), { id: src.id, text: `${src.title} ${src.summary}` }]
    w.bullets.forEach((b, j) => checkLine(`work.${i}.bullets.${j}`, b, sources, src.skills))
  }
  for (const [i, p] of content.projects.entries()) {
    const src = profile.projects.find((x) => x.id === p.id)
    if (!src) {
      issues.push({ location: `projects.${i}`, kind: 'structure', token: p.name, message: 'This project is not in your profile.' })
      continue
    }
    const sources: Source[] = [...src.bullets.map((b) => ({ id: b.id, text: b.text })), { id: src.id, text: `${src.name} ${src.description}` }]
    p.bullets.forEach((b, j) => checkLine(`projects.${i}.bullets.${j}`, b, sources, src.skills))
  }

  // Summary: numbers must exist somewhere in the profile or be the computed years of experience.
  const years = yearsOfExperience(profile, o.now)
  const allowedNumbers = new Set([...numbersIn(allText), `${Math.floor(years)}y`, `${Math.floor(years)}`, `${Math.round(years)}y`, `${Math.round(years)}`, `${Math.floor(years)}+`])
  for (const n of numbersIn(content.summary.text)) {
    if (!allowedNumbers.has(n)) issues.push({ location: 'summary', kind: 'number', token: n, message: `The number ${n} is not in your profile.` })
  }
  for (const term of findTerms(content.summary.text)) {
    if (!allTerms.has(term) && !skillCanon.has(term)) issues.push({ location: 'summary', kind: 'entity', token: term, message: `"${term}" is not in your profile.` })
  }
  for (const [i, s] of content.skills.entries()) {
    const canon = canonicalTerm(s)
    if (!(canon ? skillCanon.has(canon) || allTerms.has(canon) : allFolded.includes(fold(s)))) {
      issues.push({ location: `skills.${i}`, kind: 'entity', token: s, message: `"${s}" is not in your profile.` })
    }
  }
  return issues
}
