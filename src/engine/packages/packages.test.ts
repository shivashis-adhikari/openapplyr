import { describe, expect, it } from 'vitest'
import { HuntConfigSchema, type HuntMode, type Profile } from '../../shared/domain'
import { json } from '../core/db'
import { ingest } from '../jobs/ingest'
import { saveHunt } from '../match/hunts'
import { heuristicResume, toProfile } from '../profile/extract'
import { saveProfile } from '../profile/store'
import { SAMPLE_RESUME, fakeHttp, fixture, testCtx, testServices } from '../test/harness'
import { greenhouseForm, recruiteeForm } from './form'
import { runPrepare } from './handlers'
import { approvePackage, expireClosed, listPackages, packageDetail, regeneratePackage, skipPackage, updateAnswer } from './store'

const NOW = Date.UTC(2026, 8, 28, 10)
const base = toProfile(heuristicResume(SAMPLE_RESUME))
const profile: Profile = { ...base, jobSearch: { ...base.jobSearch, workAuthorization: [{ country: 'PT', authorized: true, needsSponsorship: false }] } }
const gh = fixture('greenhouse') as { questions: Parameters<typeof greenhouseForm>[0] }
const DESCRIPTION = '<h2>Requirements</h2><ul><li>5+ years building backend services in Go</li><li>PostgreSQL and Kafka in production</li><li>Terraform on AWS</li></ul>'

function setup(o: { kind?: 'greenhouse' | 'lever'; mode?: HuntMode; score?: number } = {}) {
  const ctx = testCtx()
  ctx.now = () => NOW
  const s = testServices(ctx)
  ctx.http = fakeHttp([[/boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/1\?questions=true/, gh.questions]])
  saveProfile(ctx.db, profile)
  const kind = o.kind ?? 'greenhouse'
  const srcId = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES (?, 'acme', 'Acme', '{}', 0)", [kind]).lastInsertRowid
  const url = kind === 'greenhouse' ? 'https://job-boards.greenhouse.io/acme/jobs/1' : 'https://jobs.lever.co/acme/0b1c2d3e'
  ingest(
    ctx.db,
    { id: srcId, kind },
    { complete: true, postings: [{ externalId: '1', title: 'Senior Backend Engineer', company: 'Acme', url, applyUrl: url, locationText: 'Lisbon, Portugal', descriptionHtml: DESCRIPTION, postedAt: NOW, meta: { token: 'acme' } }] },
    NOW,
  )
  const jobId = ctx.db.get<{ id: number }>('SELECT id FROM jobs')!.id
  const hunt = saveHunt(ctx.db, { name: 'Backend', mode: o.mode ?? 'review', active: true, baseResumeId: null, config: HuntConfigSchema.parse({ titles: ['Backend Engineer'] }) }, NOW)
  ctx.db.run("INSERT INTO job_scores (job_id, hunt_id, stage, passed, score, created_at) VALUES (?, ?, 'judged', 1, ?, ?)", [jobId, hunt.id, o.score ?? 72, NOW])
  return { ctx, s, jobId, huntId: hunt.id }
}

describe('form specs', () => {
  it('reads the whole Greenhouse form, keeping the file field for the resume', () => {
    const q = greenhouseForm(gh.questions)
    expect(q.find((x) => x.label === 'Resume/CV')).toMatchObject({ fieldName: 'resume', type: 'file', required: true })
    expect(q.find((x) => x.fieldName === 'question_68935492')).toMatchObject({ type: 'select', options: ['Yes', 'No'] })
    expect(q.some((x) => x.fieldName === 'latitude')).toBe(false)
  })

  it('reads Recruitee open questions and drops info boxes', () => {
    const offers = (fixture('recruitee') as { list: { offers: { open_questions?: unknown[] }[] } }).list.offers
    const open = offers.find((o) => o.open_questions?.length)!.open_questions
    const q = recruiteeForm(open)
    expect(q[0]).toMatchObject({ label: 'Full name', required: true })
    expect(q.find((x) => x.label === 'Have you previously worked at bunq?')).toMatchObject({ type: 'radio', options: ['Yes', 'No'] })
    expect(q.every((x) => !/Each country has different rules/.test(x.label))).toBe(true)
  })
})

describe('packages', () => {
  it('prepares a package from the live form, then waits for the one answer only the user can give', async () => {
    const { ctx, s, jobId, huntId } = setup()
    const id = await runPrepare(ctx, s, jobId, huntId)
    const p = packageDetail(ctx, id)
    expect(p.status).toBe('ready')
    expect(p.resumeId).not.toBeNull()
    // Stripe's form has a cover letter field, so the default "when accepted" writes one.
    expect(p.coverLetter).toMatch(/^Dear Hiring Manager,/)
    const a = Object.fromEntries(p.answers.map((x) => [x.question, x]))
    expect(a['First Name']!.answer).toBe('Maya')
    expect(a['Are you authorized to work in the location(s) you selected in your previous response?']!.answer).toBe('Yes')
    expect(p.answers.filter((x) => x.needsUser).map((x) => x.fieldName)).toEqual(['question_69457838'])
    expect(p.gates.find((g) => g.id === 'answers')).toMatchObject({ ok: false })
    expect(p.gates.find((g) => g.id === 'factlock')).toMatchObject({ ok: true })

    expect(() => approvePackage(ctx, id, 'user')).toThrow(/required question/)
    const edited = updateAnswer(ctx, id, 'question_69457838', 'No', 'company')
    expect(edited.gates.find((g) => g.id === 'answers')!.ok).toBe(true)
    expect(ctx.db.get<{ answer: string }>('SELECT answer FROM answers WHERE scope_company_id IS NOT NULL')!.answer).toBe('No')

    const appId = approvePackage(ctx, id, 'user')
    expect(ctx.db.get<{ status: string; group_key: string }>('SELECT status, group_key FROM applications WHERE id = ?', [appId])).toMatchObject({ status: 'queued' })
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE type = 'apply.run'")!.n).toBe(1)
    expect(() => approvePackage(ctx, id, 'user')).toThrow(/already approved/)
    // Preparing the same job again returns the live package instead of a second one.
    expect(await runPrepare(ctx, s, jobId, huntId)).toBe(id)
  })

  it('refuses an answer that is not one of the options', async () => {
    const { ctx, s, jobId, huntId } = setup()
    const id = await runPrepare(ctx, s, jobId, huntId)
    expect(() => updateAnswer(ctx, id, 'question_69457838', 'Maybe', 'no')).toThrow(/Pick one of/)
  })

  it('autopilot sends a package that passes every gate, and holds one that does not', async () => {
    const pass = setup({ kind: 'lever', mode: 'autopilot', score: 91 })
    const id = await runPrepare(pass.ctx, pass.s, pass.jobId, pass.huntId)
    const p = packageDetail(pass.ctx, id)
    expect(p.gates.filter((g) => !g.ok)).toEqual([])
    expect(p.status).toBe('approved')

    const low = setup({ kind: 'lever', mode: 'autopilot', score: 70 })
    const id2 = await runPrepare(low.ctx, low.s, low.jobId, low.huntId)
    const p2 = packageDetail(low.ctx, id2)
    expect(p2.status).toBe('ready')
    expect(p2.gates.filter((g) => !g.ok).map((g) => g.id)).toEqual(['score'])
  })

  it('records a failure with its reason, and regenerating starts over', async () => {
    const { ctx, s, jobId, huntId } = setup()
    ctx.db.run("UPDATE jobs SET description_md = '', meta = '{}'")
    await expect(runPrepare(ctx, s, jobId, huntId)).rejects.toMatchObject({ code: 'NO_DESCRIPTION' })
    const [failed] = listPackages(ctx, 'queue')
    expect(failed).toMatchObject({ status: 'failed' })
    expect(packageDetail(ctx, failed!.id).error).toMatch(/could not be loaded/)
    regeneratePackage(ctx, failed!.id)
    expect(listPackages(ctx, 'all')).toEqual([])
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE type = 'packages.prepare'")!.n).toBe(1)
  })

  it('skipping a package skips the job and records why', async () => {
    const { ctx, s, jobId, huntId } = setup()
    const id = await runPrepare(ctx, s, jobId, huntId)
    skipPackage(ctx, id, 'salary')
    expect(packageDetail(ctx, id).status).toBe('skipped')
    expect(ctx.db.get<{ user_state: string; skip_reason: string }>('SELECT user_state, skip_reason FROM jobs WHERE id = ?', [jobId])).toEqual({ user_state: 'skipped', skip_reason: 'salary' })
    expect(ctx.db.get<{ action: string }>('SELECT action FROM feedback')!.action).toBe('skip')
  })

  it('expires packages whose posting closed', async () => {
    const { ctx, s, jobId, huntId } = setup()
    const id = await runPrepare(ctx, s, jobId, huntId)
    ctx.db.run('UPDATE jobs SET closed_at = ?', [NOW])
    expect(expireClosed(ctx)).toBe(1)
    expect(packageDetail(ctx, id).status).toBe('expired')
    expect(json.parse(ctx.db.get<{ gates: string }>('SELECT gates FROM packages')!.gates, [])).not.toEqual([])
  })
})
