import type { HuntConfig, JobLocation, Profile, Remote, Salary, Signal } from '../../shared/domain'
import { companyKey, titleKey } from '../jobs/classify'
import { countryName, distanceKm } from '../jobs/geo'
import { ANNUAL_FACTOR, formatSalary } from '../jobs/salary'

export type FilterJob = {
  titleNorm: string
  title: string
  company: string
  companyBlocked: boolean
  seniority: string | null
  employment: string | null
  contract: string | null
  remote: Remote
  locations: JobLocation[]
  remoteCountries: string[]
  remoteGlobal: boolean
  salary: Salary | null
  annualMin: number | null
  annualMax: number | null
  postedAt: number | null
  firstSeenAt: number
  signals: Signal[]
  recentApplicationsToCompany: number
}

export type FilterCode = 'title' | 'exclude' | 'level' | 'employment' | 'contract' | 'location' | 'salary' | 'company' | 'staffing' | 'sponsorship' | 'clearance' | 'scam' | 'age' | 'cooldown'
export type FilterResult = { passed: boolean; reasons: string[]; codes: FilterCode[]; notes: string[] }

export const FILTER_LABELS: Record<FilterCode, string> = {
  title: 'Title does not match',
  exclude: 'Title has an excluded word',
  level: 'Level outside your range',
  employment: 'Employment type',
  contract: 'Contract type',
  location: 'Location or workplace',
  salary: 'Salary',
  company: 'Excluded company',
  staffing: 'Staffing agency',
  sponsorship: 'No visa sponsorship',
  clearance: 'Clearance or citizenship',
  scam: 'Possible scam',
  age: 'Posted too long ago',
  cooldown: 'Company cooldown',
}

/** Seniority and filler words ignored when matching a job title against the titles a user wants. */
const TITLE_NOISE = new Set(['senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead', 'head', 'of', 'i', 'ii', 'iii', 'iv', 'the', 'a', 'an', '-', '&', 'and', 'associate', 'intern'])

function titleWords(s: string): string[] {
  return titleKey(s)
    .split(/[\s,/()]+/)
    .filter((w) => w && !TITLE_NOISE.has(w))
}

/** A job title matches a wanted title when it contains all of that title's meaningful words, in any order. */
export function titleMatches(jobTitleNorm: string, wanted: string[]): string | null {
  const jobWords = new Set(jobTitleNorm.split(/[\s,/()]+/))
  for (const w of wanted) {
    const words = titleWords(w)
    if (words.length && words.every((x) => jobWords.has(x) || [...jobWords].some((j) => j.startsWith(x) && x.length >= 4))) return w
  }
  return null
}

function placeLabel(l: JobLocation): string {
  return l.city ? `${l.city}${l.country ? `, ${l.country}` : ''}` : l.country ? countryName(l.country) : l.text
}

/** Location and workplace rules. Returns a reason when the job is out of range, or null when it fits. */
function locationReason(job: FilterJob, c: HuntConfig): { reason: string | null; note: string | null } {
  const w = c.workplace
  if (job.remote === 'remote') {
    if (!w.remote) return { reason: 'Remote role; this hunt is for on-site or hybrid work.', note: null }
    if (!c.remoteCountries.length || job.remoteGlobal) return { reason: null, note: null }
    if (!job.remoteCountries.length) return { reason: null, note: 'Remote, but the posting does not say which countries it accepts.' }
    if (job.remoteCountries.some((x) => c.remoteCountries.includes(x))) return { reason: null, note: null }
    return { reason: `Remote only in ${job.remoteCountries.slice(0, 4).map(countryName).join(', ')}${job.remoteCountries.length > 4 ? ' and others' : ''}.`, note: null }
  }
  if (job.remote === 'hybrid' && !w.hybrid) return { reason: 'Hybrid role; this hunt excludes hybrid.', note: null }
  if (job.remote === 'onsite' && !w.onsite) return { reason: 'On-site role; this hunt excludes on-site.', note: null }
  if (job.remote === 'unknown' && !job.locations.length) return { reason: null, note: 'The posting does not state a location.' }
  if (!c.places.length) return { reason: null, note: null }
  for (const l of job.locations) {
    for (const p of c.places) {
      if (l.lat != null && l.lon != null && p.lat != null && p.lon != null) {
        if (distanceKm({ lat: l.lat, lon: l.lon }, { lat: p.lat, lon: p.lon }) <= Math.max(p.radiusKm, 5)) return { reason: null, note: null }
      } else if (!p.city && p.country && l.country === p.country) {
        return { reason: null, note: null }
      } else if (!l.city && l.country && p.country === l.country) {
        return { reason: null, note: `The posting names only ${countryName(l.country)}, not a city.` }
      }
    }
  }
  const where = job.locations.length ? job.locations.slice(0, 2).map(placeLabel).join('; ') : 'an unstated place'
  const wanted = c.places.map((p) => (p.radiusKm > 0 && p.city ? `${p.label} + ${p.radiusKm} km` : p.label)).join(', ')
  return { reason: `${job.remote === 'hybrid' ? 'Hybrid in' : 'Based in'} ${where}, outside ${wanted}.`, note: null }
}

function salaryReason(job: FilterJob, c: HuntConfig): { reason: string | null; note: string | null } {
  const floor = c.salaryFloor
  if (!floor) return { reason: null, note: null }
  if (!job.salary || (job.annualMax == null && job.annualMin == null)) {
    return c.includeUnknownSalary ? { reason: null, note: 'No salary in the posting.' } : { reason: 'No salary in the posting, and this hunt requires one.', note: null }
  }
  if (job.salary.currency && job.salary.currency !== floor.currency) {
    return { reason: null, note: `Pays in ${job.salary.currency}; your floor is in ${floor.currency}, so they were not compared.` }
  }
  const floorAnnual = floor.amount * ANNUAL_FACTOR[floor.period]
  const top = job.annualMax ?? job.annualMin!
  if (top < floorAnnual) {
    return { reason: `Pays ${formatSalary(job.salary)}, below your floor of ${formatSalary({ min: floor.amount, max: null, currency: floor.currency, period: floor.period, text: '' }).replace(/^from /, '')}.`, note: null }
  }
  return { reason: null, note: null }
}

/**
 * Deterministic filters, run before any model call. Every rejection comes with a sentence the user can
 * read to see which rule decided it, so an over-strict hunt is easy to fix.
 */
export function applyFilters(job: FilterJob, c: HuntConfig, profile: Profile, now: number): FilterResult {
  const reasons: string[] = []
  const codes: FilterCode[] = []
  const notes: string[] = []
  const reject = (code: FilterCode, reason: string) => {
    codes.push(code)
    reasons.push(reason)
  }
  const wanted = [...c.titles, ...c.titleSynonyms]
  if (!titleMatches(job.titleNorm, wanted)) reject('title', `Title "${job.title}" does not match ${c.titles.slice(0, 3).map((t) => `"${t}"`).join(', ')}.`)
  const excluded = c.excludeKeywords.find((k) => k.trim() && (` ${job.titleNorm} `).includes(` ${titleKey(k)} `))
  if (excluded) reject('exclude', `Title contains "${excluded}", which this hunt excludes.`)
  if (c.seniority.length && job.seniority && !c.seniority.includes(job.seniority as never)) reject('level', `Level is ${job.seniority}; this hunt wants ${c.seniority.join(', ')}.`)
  if (c.employment.length && job.employment && !c.employment.includes(job.employment as never)) reject('employment', `${job.employment.replace('_', '-')} role; this hunt wants ${c.employment.map((e) => e.replace('_', '-')).join(', ')}.`)
  if (c.contract.length && job.contract && !c.contract.includes(job.contract as never)) reject('contract', `${job.contract.toUpperCase()} contract; this hunt accepts ${c.contract.map((x) => x.toUpperCase()).join(', ')}.`)
  const loc = locationReason(job, c)
  if (loc.reason) reject('location', loc.reason)
  if (loc.note) notes.push(loc.note)
  const sal = salaryReason(job, c)
  if (sal.reason) reject('salary', sal.reason)
  if (sal.note) notes.push(sal.note)
  const key = companyKey(job.company)
  if (job.companyBlocked || c.companiesExclude.some((x) => companyKey(x) === key)) reject('company', `${job.company} is on your excluded list.`)
  if (c.excludeStaffing && job.signals.some((s) => s.kind === 'staffing')) reject('staffing', 'Posted by a staffing agency.')
  if (c.requireSponsorship && job.signals.some((s) => s.kind === 'no_sponsorship')) reject('sponsorship', 'The posting says it will not sponsor a visa.')
  if (job.signals.some((s) => s.kind === 'clearance') && !profile.jobSearch.clearance) reject('clearance', job.signals.find((s) => s.kind === 'clearance')!.label + ', which your profile does not list.')
  const scam = job.signals.find((s) => s.kind === 'scam' && s.severity === 'block')
  if (scam) reject('scam', `Possible scam: ${scam.label.toLowerCase()}.`)
  const age = now - (job.postedAt ?? job.firstSeenAt)
  if (age > c.postedWithinDays * 86_400_000) reject('age', `Posted ${Math.round(age / 86_400_000)} days ago; this hunt looks at the last ${c.postedWithinDays} days.`)
  if (job.recentApplicationsToCompany >= c.companyCooldown.max) {
    reject('cooldown', `You applied to ${job.company} ${job.recentApplicationsToCompany} times in the last ${c.companyCooldown.days} days (limit ${c.companyCooldown.max}).`)
  }
  return { passed: reasons.length === 0, reasons, codes, notes }
}
