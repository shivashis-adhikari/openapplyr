import type { HuntConfig, HuntMode, JobLocation, Judgment, PreparedAnswer, ReviewIssue } from '../../shared/domain'
import type { Meter } from '../ai/service'
import { json } from '../core/db'
import { AppError, errorMessage, isPermanent } from '../core/errors'
import type { Ctx } from '../engine'
import { resolveForm } from '../answers/resolve'
import { keywordCoverage, resumeAsText, reviewPrompt, writeLetter } from '../docs/letter'
import { defaultTemplate, insertLetter, insertResume } from '../docs/store'
import { tailorResume } from '../docs/tailor'
import { ensureDetails } from '../jobs/details'
import { huntFor } from '../match/hunts'
import { loadProfile, loadVoice } from '../profile/store'
import type { Services } from '../services'
import { type FormSpec, formSpecFor } from './form'
import { gatesPass } from './gates'
import { refreshGates } from './store'

export type PackageJob = {
  id: number
  group_id: number | null
  source_kind: string
  external_id: string
  company_id: number | null
  company_name: string
  title: string
  url: string
  apply_url: string | null
  description_md: string
  locations: string
  signals: string
  meta: string
  closed_at: number | null
}

export const jobCountry = (j: Pick<PackageJob, 'locations'>): string | null => json.parse<JobLocation[]>(j.locations, []).find((l) => l.country)?.country ?? null

const wantsLetter = (config: HuntConfig, form: FormSpec | null) =>
  config.coverLetter === 'always' || (config.coverLetter === 'when_accepted' && (!form || form.questions.some((q) => /cover letter/i.test(q.label))))

/**
 * Builds everything needed to apply: a tailored resume (fact-locked), a cover letter when useful,
 * answers to every known form question, and the autopilot gates. Returns the package id.
 * A job has at most one live package (unique index); calling again returns the existing one.
 */
export async function preparePackage(ctx: Ctx, s: Services, jobId: number, huntId: number | null, signal?: AbortSignal): Promise<number> {
  const { db } = ctx
  const existing = db.get<{ id: number }>("SELECT id FROM packages WHERE job_id = ? AND status IN ('preparing', 'ready', 'approved')", [jobId])
  if (existing) return existing.id
  const hunt = huntFor(db, huntId)
  const { profile } = loadProfile(db)
  if (!profile.work.length) throw new AppError('NO_PROFILE', 'Add your work history to your profile before preparing applications.', { permanent: true })

  // A retry replaces the failed attempt.
  db.run("DELETE FROM packages WHERE job_id = ? AND status = 'failed'", [jobId])
  const pkgId = db.run("INSERT INTO packages (job_id, hunt_id, status, created_at) VALUES (?, ?, 'preparing', ?)", [jobId, hunt.id, ctx.now()]).lastInsertRowid
  ctx.bus.changed('packages')
  const meter: Meter = { cost: 0 }
  const call = { signal, meter }
  try {
    await ensureDetails(ctx, jobId, signal)
    const job = db.get<PackageJob>('SELECT * FROM jobs WHERE id = ?', [jobId])
    if (!job) throw new AppError('NOT_FOUND', 'That job is no longer in your database.', { permanent: true })
    if (!job.description_md.trim()) throw new AppError('NO_DESCRIPTION', 'The posting text could not be loaded, so nothing can be tailored to it.', { permanent: true })
    const score = hunt.id ? db.get<{ score: number | null; judgment: string | null }>('SELECT score, judgment FROM job_scores WHERE job_id = ? AND hunt_id = ?', [jobId, hunt.id]) : undefined
    const judgment = json.parse<Judgment | null>(score?.judgment, null)
    const posting = { title: job.title, company: job.company_name, description: job.description_md }

    const tailored = await tailorResume(s.ai, { profile, job: posting, judgment, maxPages: profile.work.length > 4 ? 2 : 1 }, call)
    const review: ReviewIssue[] = hunt.config.reviewer
      ? (await s.ai.structured(reviewPrompt, { profile, resumeText: resumeAsText(tailored.content), job: posting }, { task: 'Review resume', ...call })).issues
      : []
    const form = await formSpecFor(db, ctx.http, job, signal)
    const letter = wantsLetter(hunt.config, form) ? await writeLetter(s.ai, { profile, job: posting, judgment, voice: loadVoice(db).description, region: ctx.settings.get().region }, call) : null
    const answers: PreparedAnswer[] = form
      ? await resolveForm(form.questions, { profile, job: { ...posting, companyId: job.company_id, country: jobCountry(job) }, db, letterText: letter?.text ?? null, allowGenerated: true }, s.ai, call)
      : []
    // Documents are written only once everything succeeded, so a failed attempt leaves nothing behind.
    db.tx(() => {
      const resumeId = insertResume(ctx, {
        kind: 'tailored',
        name: `${job.company_name}, ${job.title}`,
        baseId: hunt.baseResumeId,
        jobId,
        content: tailored.content,
        templateId: hunt.config.template,
        pageSize: defaultTemplate(ctx).pageSize,
        factLock: tailored.issues,
        review,
        keywords: keywordCoverage(job.description_md, judgment?.keywords ?? [], tailored.content, profile),
      })
      const letterId = letter ? insertLetter(ctx, { jobId, body: letter.text, plan: letter.plan, issues: letter.issues, templateId: hunt.config.template }) : null
      db.run("UPDATE packages SET resume_id = ?, cover_letter_id = ?, answers = ?, questions = ?, gates = ?, status = 'ready', error = NULL, cost = ? WHERE id = ?", [
        resumeId,
        letterId,
        JSON.stringify(answers),
        JSON.stringify(form ? { source: form.source, count: form.questions.length } : null),
        '[]',
        meter.cost,
        pkgId,
      ])
      refreshGates(ctx, pkgId)
    })
    ctx.bus.changed('packages', 'documents')
    return pkgId
  } catch (err) {
    db.run("UPDATE packages SET status = 'failed', error = ?, cost = ? WHERE id = ?", [errorMessage(err), meter.cost, pkgId])
    ctx.bus.changed('packages')
    throw err
  }
}

/** Autopilot hands a package straight to the apply queue when every gate passes. */
export function shouldAutoApprove(mode: HuntMode, gatesJson: string): boolean {
  return mode === 'autopilot' && gatesPass(json.parse(gatesJson, []))
}

/** Queue task: a failed attempt leaves a "failed" package the user can retry; transient errors retry by themselves. */
export function retryable(err: unknown): boolean {
  return !isPermanent(err) && !(err instanceof AppError && ['BUDGET', 'NO_MODEL', 'AUTH', 'QUOTA'].includes(err.code))
}
