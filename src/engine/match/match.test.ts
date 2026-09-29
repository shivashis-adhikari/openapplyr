import { describe, expect, it } from 'vitest'
import { HuntConfigSchema, type Judgment } from '../../shared/domain'
import { ingest } from '../jobs/ingest'
import { resolvePlace } from '../jobs/geo'
import { heuristicResume, toProfile } from '../profile/extract'
import { saveProfile } from '../profile/store'
import { SAMPLE_RESUME, testCtx, testServices } from '../test/harness'
import { type FilterJob, applyFilters, titleMatches } from './filters'
import { saveHunt } from './hunts'
import { computeScore, heuristicJudgment, sanitizeJudgment } from './judge'
import { scoreNewJobs } from './pipeline'

const profile = toProfile(heuristicResume(SAMPLE_RESUME))
const NOW = Date.UTC(2026, 8, 28)

const job = (over: Partial<FilterJob> = {}): FilterJob => ({
  titleNorm: 'senior backend engineer',
  title: 'Senior Backend Engineer',
  company: 'Acme',
  companyBlocked: false,
  seniority: 'senior',
  employment: 'full_time',
  contract: null,
  remote: 'onsite',
  locations: [resolvePlace('Lisbon, Portugal')],
  remoteCountries: [],
  remoteGlobal: false,
  salary: null,
  annualMin: null,
  annualMax: null,
  postedAt: NOW - 3 * 86_400_000,
  firstSeenAt: NOW,
  signals: [],
  recentApplicationsToCompany: 0,
  ...over,
})

const lisbon = resolvePlace('Lisbon, Portugal')
const cfg = (over: Record<string, unknown> = {}) =>
  HuntConfigSchema.parse({ titles: ['Backend Engineer'], places: [{ label: 'Lisbon', city: 'Lisbon', country: 'PT', lat: lisbon.lat, lon: lisbon.lon, radiusKm: 40 }], ...over })

describe('filters', () => {
  it('matches titles on meaningful words in any order, ignoring level words', () => {
    expect(titleMatches('senior backend engineer', ['Backend Engineer'])).toBe('Backend Engineer')
    expect(titleMatches('software engineer backend', ['Backend Engineer'])).toBe('Backend Engineer')
    expect(titleMatches('frontend engineer', ['Backend Engineer'])).toBeNull()
  })

  it('passes a good fit and explains each rejection', () => {
    expect(applyFilters(job(), cfg(), profile, NOW)).toMatchObject({ passed: true, reasons: [] })
    const r = applyFilters(job({ title: 'Engineering Manager, Backend', titleNorm: 'engineering manager backend' }), cfg({ excludeKeywords: ['manager'] }), profile, NOW)
    expect(r.reasons.join(' ')).toMatch(/contains "manager"/)
  })

  it('treats an unstated level as unknown rather than excluded', () => {
    expect(applyFilters(job({ seniority: null }), cfg({ seniority: ['senior'] }), profile, NOW).passed).toBe(true)
    expect(applyFilters(job({ seniority: 'junior' }), cfg({ seniority: ['senior'] }), profile, NOW).reasons[0]).toMatch(/Level is junior/)
  })

  it('checks distance for on-site roles and country lists for remote roles', () => {
    const porto = resolvePlace('Porto, Portugal')
    expect(applyFilters(job({ locations: [porto] }), cfg(), profile, NOW).reasons[0]).toMatch(/outside Lisbon \+ 40 km/)
    expect(applyFilters(job({ locations: [resolvePlace('Oeiras, Portugal')] }), cfg(), profile, NOW).passed).toBe(true)
    const remote = cfg({ workplace: { onsite: false, hybrid: false, remote: true }, remoteCountries: ['PT', 'ES'] })
    expect(applyFilters(job({ remote: 'remote', locations: [], remoteCountries: ['US'] }), remote, profile, NOW).reasons[0]).toMatch(/Remote only in United States/)
    expect(applyFilters(job({ remote: 'remote', locations: [], remoteCountries: ['PT'] }), remote, profile, NOW).passed).toBe(true)
    expect(applyFilters(job({ remote: 'remote', locations: [], remoteGlobal: true }), remote, profile, NOW).passed).toBe(true)
    expect(applyFilters(job({ remote: 'remote', locations: [] }), cfg({ workplace: { onsite: true, hybrid: true, remote: false } }), profile, NOW).reasons[0]).toMatch(/Remote role/)
  })

  it('compares salary only in the same currency', () => {
    const floor = { salaryFloor: { amount: 80000, currency: 'EUR', period: 'year' } }
    const low = { salary: { min: 60000, max: 70000, currency: 'EUR', period: 'year' as const, text: '' }, annualMin: 60000, annualMax: 70000 }
    expect(applyFilters(job(low), cfg(floor), profile, NOW).reasons[0]).toMatch(/below your floor/)
    const usd = { ...low, salary: { ...low.salary, currency: 'USD' } }
    const r = applyFilters(job(usd), cfg(floor), profile, NOW)
    expect(r.passed).toBe(true)
    expect(r.notes[0]).toMatch(/not compared/)
    expect(applyFilters(job(), cfg({ ...floor, includeUnknownSalary: false }), profile, NOW).reasons[0]).toMatch(/requires one/)
  })

  it('applies company cooldown, clearance, scam and age rules', () => {
    expect(applyFilters(job({ recentApplicationsToCompany: 2 }), cfg(), profile, NOW).reasons[0]).toMatch(/applied to Acme 2 times/)
    const clearance = [{ kind: 'clearance' as const, severity: 'warn' as const, label: 'Security clearance required', detail: '' }]
    expect(applyFilters(job({ signals: clearance }), cfg(), profile, NOW).reasons[0]).toMatch(/clearance/)
    const scam = [{ kind: 'scam' as const, severity: 'block' as const, label: 'Mentions depositing a check', detail: '' }]
    expect(applyFilters(job({ signals: scam }), cfg(), profile, NOW).reasons[0]).toMatch(/Possible scam/)
    expect(applyFilters(job({ postedAt: NOW - 45 * 86_400_000 }), cfg(), profile, NOW).reasons[0]).toMatch(/Posted 45 days ago/)
  })
})

describe('score', () => {
  const base: Judgment = {
    requirements: [
      { text: 'Go', kind: 'must', weight: 3, verdict: 'met', evidence: ['b1'], note: '' },
      { text: 'Kafka', kind: 'must', weight: 1, verdict: 'missing', evidence: [], note: '' },
      { text: 'Rust', kind: 'nice', weight: 1, verdict: 'partial', evidence: [], note: '' },
    ],
    seniorityFit: 'match',
    seniorityNote: '',
    domainFit: 2,
    domainNote: '',
    logistics: [],
    dealbreakers: [],
    keywords: [],
    embeddedInstructions: [],
    aiPolicy: 'none',
    summary: '',
  }

  it('computes weighted coverage and caps on dealbreakers', () => {
    // must: 3/4 = 0.75 -> 52.5; nice 0.5 -> 7.5; seniority 10; domain 5 => 75
    expect(computeScore(base)).toEqual({ must: 53, nice: 8, seniority: 10, domain: 5, capped: false, total: 75 })
    expect(computeScore({ ...base, dealbreakers: ['on-call'] })).toMatchObject({ capped: true, total: 40 })
    expect(computeScore({ ...base, seniorityFit: 'far_above' }).seniority).toBe(0)
  })

  it('drops invented evidence and downgrades unsupported "met"', () => {
    const j = sanitizeJudgment({ ...base, requirements: [{ ...base.requirements[0]!, evidence: ['nope'] }] }, profile)
    expect(j.requirements[0]).toMatchObject({ evidence: [], verdict: 'partial' })
  })

  it('offline judgment reads requirements and checks them against the profile', () => {
    const description = [
      'We are hiring a backend engineer.',
      '## Requirements',
      '- 5+ years building backend services',
      '- Strong Go and PostgreSQL experience',
      '- Experience with Scala',
      '## Nice to have',
      '- Kafka',
    ].join('\n')
    const j = heuristicJudgment({ profile, title: 'Senior Backend Engineer', company: 'Acme', location: 'Lisbon', description, wantedTitles: ['Backend Engineer'] })
    const verdict = (t: string) => j.requirements.find((r) => r.text.includes(t))!.verdict
    expect(verdict('5+ years')).toBe('met')
    expect(verdict('Go and PostgreSQL')).toBe('met')
    expect(verdict('Scala')).toBe('missing')
    expect(j.requirements.find((r) => r.text === 'Kafka')!.kind).toBe('nice')
    expect(j.seniorityFit).toBe('match')
  })
})

describe('scoring pipeline', () => {
  it('filters, judges, scores and queues strong matches', async () => {
    const ctx = testCtx()
    ctx.now = () => NOW
    const s = testServices(ctx)
    saveProfile(ctx.db, profile)
    const srcId = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES ('greenhouse', 'acme', 'Acme', '{}', 0)").lastInsertRowid
    const desc = (extra: string) => `<h2>Requirements</h2><ul><li>5+ years building backend services in Go</li><li>PostgreSQL and Kafka in production</li>${extra}</ul>`
    ingest(
      ctx.db,
      { id: srcId, kind: 'greenhouse' },
      {
        complete: true,
        postings: [
          { externalId: '1', title: 'Senior Backend Engineer', company: 'Acme', url: 'https://acme.example/1', locationText: 'Lisbon, Portugal', descriptionHtml: desc(''), postedAt: NOW },
          { externalId: '2', title: 'Senior Backend Engineer', company: 'Acme', url: 'https://acme.example/2', locationText: 'Tokyo, Japan', descriptionHtml: desc(''), postedAt: NOW },
          { externalId: '3', title: 'Product Designer', company: 'Acme', url: 'https://acme.example/3', locationText: 'Lisbon, Portugal', descriptionHtml: '<p>Figma</p>', postedAt: NOW },
        ],
      },
      NOW,
    )
    saveHunt(ctx.db, { name: 'Backend', mode: 'review', active: true, baseResumeId: null, config: cfg() }, NOW)
    const run = await scoreNewJobs(ctx, s, null)
    expect(run).toMatchObject({ judged: 1, filtered: 2, queued: 1, errors: 0 })
    const scores = ctx.db.all<{ job_id: number; stage: string; score: number | null }>('SELECT job_id, stage, score FROM job_scores ORDER BY job_id')
    expect(scores.map((x) => x.stage)).toEqual(['judged', 'filtered', 'filtered'])
    expect(scores[0]!.score).toBeGreaterThanOrEqual(65)
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE type = 'packages.prepare'")!.n).toBe(1)
    // Running again does not re-judge.
    expect((await scoreNewJobs(ctx, s, null)).judged).toBe(0)
  })
})
