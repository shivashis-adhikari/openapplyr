import { describe, expect, it } from 'vitest'
import type { Chat, MockSession, OfferRow, Prep, Story } from '../../shared/api/prep'
import type { Judgment } from '../../shared/domain'
import { careerExplorer, offerTotals, skillsGap } from '../career/insights'
import { heuristicResume, toProfile } from '../profile/extract'
import { saveProfile } from '../profile/store'
import { SAMPLE_RESUME, testCtx, testServices } from '../test/harness'
import { createApplication } from '../tracker/applications'
import { registerPrepHandlers } from './handlers'
import { sourcedOnly } from './prompts'

const profile = toProfile(heuristicResume(SAMPLE_RESUME))

function setup() {
  const ctx = testCtx()
  const s = testServices(ctx)
  saveProfile(ctx.db, profile)
  registerPrepHandlers(ctx, s)
  const call = <T>(name: string, input: unknown) => ctx.router.handle(name, input) as Promise<T>
  const src = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES ('remotive', 'd', 'x', '{}', 0)").lastInsertRowid
  const job = (title: string, description: string, i: number) =>
    ctx.db.run(
      "INSERT INTO jobs (source_id, source_kind, external_id, company_name, title, title_norm, url, description_md, first_seen_at, last_seen_at, hash, updated_at) VALUES (?, 'remotive', ?, 'Acme', ?, ?, 'https://acme.example/jobs/1', ?, ?, ?, 'h', 0)",
      [src, `j${i}`, title, title.toLowerCase(), description, ctx.now(), ctx.now()],
    ).lastInsertRowid
  return { ctx, s, call, job }
}

describe('career tools', () => {
  it('counts missing requirements per job across recent matches', () => {
    const { ctx, job } = setup()
    const hunt = ctx.db.run("INSERT INTO hunts (name, config, created_at, updated_at) VALUES ('h', '{}', 0, 0)").lastInsertRowid
    const judgment = (missing: string[]): Judgment => ({
      requirements: missing.map((m) => ({ text: m, kind: 'must', weight: 2, verdict: 'missing', evidence: [], note: '' })),
      seniorityFit: 'match',
      seniorityNote: '',
      domainFit: 1,
      domainNote: '',
      logistics: [],
      dealbreakers: [],
      keywords: [],
      embeddedInstructions: [],
      aiPolicy: 'none',
      summary: '',
    })
    for (const [i, missing] of [['Kubernetes in production'], ['Kubernetes and Helm'], ['Rust']].entries()) {
      ctx.db.run("INSERT INTO job_scores (job_id, hunt_id, stage, passed, judgment, created_at) VALUES (?, ?, 'judged', 1, ?, ?)", [job('Backend Engineer', '', i), hunt, JSON.stringify(judgment(missing)), ctx.now()])
    }
    const gap = skillsGap(ctx.db, hunt, 0)
    expect(gap.jobs).toBe(3)
    expect(gap.rows[0]).toEqual({ term: 'Kubernetes', missing: 2, mustHave: 2, jobs: 3 })
  })

  it('finds nearby titles from local postings and what they ask for', () => {
    const { ctx, job } = setup()
    for (let i = 0; i < 4; i++) job('Data Engineer', 'We use Python, Kafka, PostgreSQL and Airflow on AWS.', i)
    for (let i = 4; i < 8; i++) job('iOS Engineer', 'Swift, SwiftUI and Xcode.', i)
    const rows = careerExplorer(ctx.db, profile, 0, ['Backend Engineer'])
    expect(rows[0]).toMatchObject({ title: 'Data Engineer', postings: 4 })
    expect(rows[0]!.have).toEqual(expect.arrayContaining(['Python', 'Apache Kafka', 'PostgreSQL']))
    expect(rows[0]!.missing).toContain('Apache Airflow')
    expect(rows.find((r) => r.title === 'iOS Engineer')?.overlap ?? 0).toBe(0)
  })

  it('totals offers over the vesting period', () => {
    const o = { company: 'A', title: 'B', currency: 'EUR', base: 100_000, bonusPct: 10, signOn: 20_000, equityValue: 80_000, vestingYears: 4, cliffMonths: 12, benefits: '', location: '', deadline: '' }
    expect(offerTotals(o)).toEqual({ firstYear: 150_000, averageYear: 135_000 })
    expect(offerTotals({ ...o, cliffMonths: 18 }).firstYear).toBe(130_000)
  })
})

describe('prep', () => {
  it('keeps brief points only when their source was fetched', () => {
    const b = sourcedOnly({ sections: [{ heading: 'What they do', points: [{ text: 'Payments.', source: 'posting' }, { text: 'Raised money.', source: 'https://news.example' }] }] }, ['posting'])
    expect(b.sections[0]!.points).toEqual([{ text: 'Payments.', source: 'posting' }])
  })

  it('prepares questions, drafts stories from real facts, and runs a practice interview (offline model)', async () => {
    const { ctx, call, job } = setup()
    const jobId = job('Senior Backend Engineer', '## Requirements\n- Go\n- Kafka\n- PostgreSQL', 1)
    const app = createApplication(ctx.db, { jobId, groupKey: 'job:1', companyId: null, company: 'Acme', title: 'Senior Backend Engineer', huntId: null, packageId: null, status: 'interviewing', channel: 'ats', url: null, source: 'user' }, ctx.now())

    const prep = await call<Prep>('prep.generate', { applicationId: app, part: 'questions', kind: 'technical' })
    expect(prep.likely.some((q) => /Go|Kafka/.test(q.question))).toBe(true)
    expect(prep.ask.length).toBeGreaterThan(0)

    const stories = await call<Story[]>('stories.draft', undefined)
    expect(stories.length).toBeGreaterThan(0)
    const ids = new Set(profile.work.flatMap((w) => w.bullets.map((b) => b.id)))
    const saved = await call<Story[]>('stories.list', undefined)
    for (const st of saved) expect(st.factIds.length > 0 && st.factIds.every((f) => ids.has(f))).toBe(true)

    const session = await call<MockSession>('mock.start', { applicationId: app, kind: 'technical' })
    expect(session.messages[0]).toMatchObject({ role: 'interviewer' })
    const after = await call<MockSession>('mock.answer', { id: session.id, answer: 'I moved batch jobs to event-driven workers.' })
    const graded = after.messages[1]!
    expect(graded.feedback?.specificity.score).toBe(2)
    expect(after.messages[2]).toMatchObject({ role: 'interviewer' })
  })

  it('saves offers and drafts a counter using only given numbers', async () => {
    const { call } = setup()
    const o = await call<OfferRow>('offers.save', { data: { company: 'Acme', title: 'Senior Backend Engineer', currency: 'EUR', base: 90_000 } })
    expect(o.firstYear).toBe(90_000)
    const draft = await call<{ body: string; issues: unknown[] }>('offers.negotiate', { id: o.id, target: '€98,000' })
    expect(draft.body).toContain('€98,000')
    expect(draft.issues).toEqual([])
  })
})

describe('assistant', () => {
  it('answers from local data through a tool and keeps the conversation', async () => {
    const { ctx, call } = setup()
    createApplication(ctx.db, { jobId: null, groupKey: 'm:a', companyId: null, company: 'Acme', title: 'Backend Engineer', huntId: null, packageId: null, status: 'applied', channel: 'ats', url: null, appliedAt: ctx.now(), source: 'user' }, ctx.now())
    const chat = await call<Chat>('assistant.send', { id: null, text: 'How am I doing this week?' })
    const reply = chat.messages.at(-1)!
    expect(reply.role).toBe('assistant')
    expect(reply.text).toContain('"applied": 1')
    expect(reply.role === 'assistant' && reply.actions.some((a) => a.kind === 'looked_up' && a.what === 'week_summary')).toBe(true)
    const again = await call<Chat>('assistant.send', { id: chat.id, text: 'Which applications do I have?' })
    expect(again.messages).toHaveLength(4)
  })
})
