import { describe, expect, it } from 'vitest'
import type { ResumeContent } from '../../shared/domain'
import { heuristicResume, toProfile } from '../profile/extract'
import { SAMPLE_RESUME } from '../test/harness'
import { factLock, numbersIn } from './factlock'
import { resumeStyleCheck, styleCheck } from './styleguard'

const profile = toProfile(heuristicResume(SAMPLE_RESUME))
const w0 = profile.work[0]!
const w1 = profile.work[1]!

function resume(over: Partial<ResumeContent> = {}): ResumeContent {
  return {
    name: profile.basics.name,
    headline: 'Senior Backend Engineer',
    contact: { email: '', phone: '', location: '', links: [] },
    summary: { text: 'Backend engineer with 9 years building payment systems in Go and PostgreSQL.', factIds: [] },
    work: [
      { workId: w0.id, company: w0.company, title: w0.title, location: w0.location, start: w0.start, end: w0.end, bullets: w0.bullets.map((b) => ({ sourceIds: [b.id], text: b.text })) },
      { workId: w1.id, company: w1.company, title: w1.title, location: w1.location, start: w1.start, end: w1.end, bullets: w1.bullets.map((b) => ({ sourceIds: [b.id], text: b.text })) },
    ],
    education: [],
    projects: [],
    skills: ['Go', 'PostgreSQL', 'Kafka'],
    certifications: [],
    languages: [],
    ...over,
  }
}

describe('numbersIn', () => {
  it('normalizes units, words, currency and grouping, and ignores calendar years', () => {
    expect(numbersIn('Reduced costs by 28%')).toContain('28%')
    expect(numbersIn('reduced costs by twenty-eight percent')).not.toContain('28%')
    expect(numbersIn('cut time by forty percent')).toContain('40%')
    expect(numbersIn('4 hours to 35 minutes')).toEqual(new Set(['4h', '35min']))
    expect(numbersIn('1,200 requests')).toContain('1200')
    expect(numbersIn('$1.2M in revenue')).toContain('1.2m')
    expect(numbersIn('In 2021 we shipped')).toEqual(new Set())
  })
})

describe('factLock', () => {
  it('accepts a resume built only from profile facts', () => {
    expect(factLock(resume(), profile)).toEqual([])
  })

  it('catches an invented metric', () => {
    const r = resume()
    r.work[0]!.bullets[0] = { sourceIds: [w0.bullets[0]!.id], text: 'Cut settlement batch time by 90% by moving jobs to event-driven workers in Go' }
    const issues = factLock(r, profile)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'number', token: '90%', location: 'work.0.bullets.0' })
  })

  it('catches a technology that is not in the cited fact or the skills list', () => {
    const r = resume()
    r.work[1]!.bullets[0] = { sourceIds: [w1.bullets[0]!.id], text: 'Built ingestion pipelines in Rust and Kafka processing 40 million events per day' }
    const issues = factLock(r, profile)
    expect(issues.map((i) => i.token)).toContain('Rust')
  })

  it('allows a skill from the profile even if the cited line does not name it', () => {
    const r = resume()
    r.work[0]!.bullets[1] = { sourceIds: [w0.bullets[1]!.id], text: 'Led a team of 5 engineers through a PostgreSQL 16 upgrade on Kubernetes with zero downtime' }
    expect(factLock(r, profile)).toEqual([])
  })

  it('catches borrowed citations, changed titles and dates, and unknown skills', () => {
    const r = resume()
    r.work[0]!.bullets[0] = { sourceIds: [w1.bullets[0]!.id], text: 'Built ingestion pipelines in Python' }
    r.work[1]!.title = 'Staff Backend Engineer'
    r.skills.push('Rust')
    const kinds = factLock(r, profile).map((i) => `${i.kind}:${i.location}`)
    expect(kinds).toContain('citation:work.0.bullets.0')
    expect(kinds).toContain('structure:work.1')
    expect(kinds).toContain('entity:skills.3')
  })

  it('checks the summary against the whole profile, allowing computed years', () => {
    expect(factLock(resume({ summary: { text: 'Engineer with 15 years in Go.', factIds: [] } }), profile).map((i) => i.token)).toContain('15y')
    expect(factLock(resume({ summary: { text: 'Engineer with 9 years in Go and Rust.', factIds: [] } }), profile).map((i) => i.token)).toEqual(['Rust'])
  })
})

describe('styleCheck', () => {
  it('flags filler phrases, leverage as a verb, and parallel framing', () => {
    const rules = styleCheck('I am excited to apply. I would leverage my proven track record. It is not just code, it is craft.', 'letter').map((i) => i.rule)
    expect(rules.filter((r) => r === 'banned_phrase').length).toBeGreaterThanOrEqual(2)
    expect(rules).toContain('parallelism')
  })

  it('enforces resume line rules', () => {
    expect(styleCheck('Built the settlement system in Go', 'bullet')).toEqual([])
    expect(styleCheck('Responsible for the settlement system', 'bullet').map((i) => i.rule)).toContain('verb_start')
    expect(styleCheck('Build the settlement system', 'bullet', { currentRole: true })).toEqual([])
    expect(styleCheck('Built my first system — fast!', 'bullet').map((i) => i.rule).sort()).toEqual(['em_dash', 'exclamation', 'pronoun'])
    expect(resumeStyleCheck(['Built a', 'Built b', 'Built c', 'Led d'])[0]!.excerpt).toBe('built')
  })

  it('checks letter length and question openings', () => {
    const short = styleCheck('Have you ever wondered about payments? I have.', 'letter').map((i) => i.rule)
    expect(short).toContain('opening')
    expect(short).toContain('length')
  })
})
