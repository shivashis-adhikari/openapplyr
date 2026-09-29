import type { Gate, PackageDetail, PackageStatus, PackageSummary, PreparedAnswer, Signal } from '../../shared/domain'
import { json } from '../core/db'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { bankSave, questionKey } from '../answers/resolve'
import { pickOption } from '../answers/questions'
import { letterDetail, resumeDetail } from '../docs/store'
import { createApplication, addEvent } from '../tracker/applications'
import { computeGates } from './gates'
import { huntFor } from '../match/hunts'

type PackageRow = {
  id: number
  job_id: number
  hunt_id: number | null
  resume_id: number | null
  cover_letter_id: number | null
  answers: string
  questions: string
  gates: string
  status: PackageStatus
  error: string | null
  cost: number
  created_at: number
  title: string
  company_name: string
  hunt_name: string | null
  score: number | null
}

const SELECT = `SELECT p.*, j.title, j.company_name, h.name hunt_name, js.score
  FROM packages p JOIN jobs j ON j.id = p.job_id
  LEFT JOIN hunts h ON h.id = p.hunt_id
  LEFT JOIN job_scores js ON js.job_id = p.job_id AND js.hunt_id = p.hunt_id`

function summary(r: PackageRow): PackageSummary {
  const answers = json.parse<PreparedAnswer[]>(r.answers, [])
  return {
    id: r.id,
    jobId: r.job_id,
    huntId: r.hunt_id,
    huntName: r.hunt_name,
    title: r.title,
    company: r.company_name,
    score: r.score,
    status: r.status,
    gatesFailed: json.parse<Gate[]>(r.gates, []).filter((g) => !g.ok).length,
    needsUser: answers.filter((a) => a.needsUser).length,
    createdAt: r.created_at,
    cost: r.cost,
  }
}

export type PackageFilter = 'queue' | 'approved' | 'done' | 'all'
const FILTERS: Record<PackageFilter, string> = {
  queue: "p.status IN ('preparing', 'ready', 'failed')",
  approved: "p.status = 'approved'",
  done: "p.status IN ('applied', 'skipped', 'expired')",
  all: '1 = 1',
}

/** The Queue: highest score first, then oldest. */
export function listPackages(ctx: Ctx, filter: PackageFilter): PackageSummary[] {
  return ctx.db.all<PackageRow>(`${SELECT} WHERE ${FILTERS[filter]} ORDER BY COALESCE(js.score, 0) DESC, p.created_at ASC LIMIT 500`).map(summary)
}

function row(ctx: Ctx, id: number): PackageRow {
  const r = ctx.db.get<PackageRow>(`${SELECT} WHERE p.id = ?`, [id])
  if (!r) throw new AppError('NOT_FOUND', 'That package no longer exists.', { permanent: true })
  return r
}

export function packageDetail(ctx: Ctx, id: number): PackageDetail {
  const r = row(ctx, id)
  const letter = r.cover_letter_id ? ctx.db.get<{ body: string; style: string | null }>('SELECT body, style FROM cover_letters WHERE id = ?', [r.cover_letter_id]) : undefined
  const job = ctx.db.get<{ signals: string }>('SELECT signals FROM jobs WHERE id = ?', [r.job_id])
  return {
    ...summary(r),
    resumeId: r.resume_id,
    coverLetterId: r.cover_letter_id,
    coverLetter: letter?.body ?? null,
    coverLetterIssues: json.parse(letter?.style, []),
    answers: json.parse<PreparedAnswer[]>(r.answers, []),
    form: json.parse(r.questions, null),
    gates: json.parse<Gate[]>(r.gates, []),
    signals: json.parse<Signal[]>(job?.signals, []),
    error: r.error,
  }
}

/** Recomputes the gates from what is stored now: edited answers, a swapped resume, a rewritten letter. */
export function refreshGates(ctx: Ctx, id: number): Gate[] {
  const r = row(ctx, id)
  const job = ctx.db.get<{ signals: string; closed_at: number | null }>('SELECT signals, closed_at FROM jobs WHERE id = ?', [r.job_id])!
  const resume = r.resume_id ? resumeDetail(ctx, r.resume_id) : null
  const gates = computeGates({
    score: r.score,
    config: huntFor(ctx.db, r.hunt_id).config,
    signals: json.parse<Signal[]>(job.signals, []),
    closed: job.closed_at !== null,
    answers: json.parse<PreparedAnswer[]>(r.answers, []),
    resume: resume ? { content: resume.content, factLock: resume.factLock, review: resume.review } : null,
    letterIssues: r.cover_letter_id ? letterDetail(ctx, r.cover_letter_id).issues : [],
  })
  ctx.db.run('UPDATE packages SET gates = ? WHERE id = ?', [JSON.stringify(gates), id])
  return gates
}

/** Approval creates the application and queues the run. Required questions must be answered first. */
export function approvePackage(ctx: Ctx, id: number, by: 'user' | 'autopilot', mode?: 'assisted'): number {
  const r = row(ctx, id)
  if (r.status !== 'ready') throw new AppError('NOT_READY', r.status === 'approved' ? 'This package is already approved.' : 'This package is not ready yet.', { permanent: true })
  const missing = json.parse<PreparedAnswer[]>(r.answers, []).filter((a) => a.needsUser)
  if (missing.length) throw new AppError('NEEDS_ANSWERS', `Answer ${missing.length === 1 ? 'the required question' : `the ${missing.length} required questions`} first.`, { permanent: true })
  const job = ctx.db.get<{ group_id: number | null; company_id: number | null; url: string; apply_url: string | null; closed_at: number | null }>('SELECT group_id, company_id, url, apply_url, closed_at FROM jobs WHERE id = ?', [r.job_id])!
  if (job.closed_at !== null) throw new AppError('CLOSED', 'This posting has closed.', { permanent: true })
  const now = ctx.now()
  const appId = ctx.db.tx(() => {
    const appId = createApplication(
      ctx.db,
      {
        jobId: r.job_id,
        groupKey: `job:${job.group_id ?? r.job_id}`,
        companyId: job.company_id,
        company: r.company_name,
        title: r.title,
        huntId: r.hunt_id,
        packageId: id,
        status: 'queued',
        channel: 'ats',
        url: job.apply_url ?? job.url,
        source: by === 'user' ? 'user' : 'app',
      },
      now,
    )
    addEvent(ctx.db, appId, 'approved', by === 'user' ? 'user' : 'app', { by }, now)
    ctx.db.run("UPDATE packages SET status = 'approved', decided_at = ? WHERE id = ?", [now, id])
    ctx.db.run("INSERT INTO feedback (job_id, hunt_id, action, reason, created_at) VALUES (?, ?, 'approve', NULL, ?)", [r.job_id, r.hunt_id, now])
    return appId
  })
  ctx.queue.enqueue('apply.run', { applicationId: appId, ...(mode ? { mode, manual: true } : {}) }, { dedupeKey: `apply:${appId}`, priority: mode ? 100 : 0 })
  ctx.bus.changed('packages', 'applications')
  return appId
}

/** Skipping a package skips the job, and the reason teaches the hunt (see match/feedback.ts). */
export function skipJob(ctx: Ctx, jobId: number, reason: string | null, huntId: number | null): void {
  const r = ctx.db.run("UPDATE jobs SET user_state = 'skipped', skip_reason = ? WHERE id = ?", [reason, jobId])
  if (!r.changes) throw new AppError('NOT_FOUND', 'That job is no longer in your database.', { permanent: true })
  ctx.db.run("INSERT INTO feedback (job_id, hunt_id, action, reason, created_at) VALUES (?, ?, 'skip', ?, ?)", [jobId, huntId, reason, ctx.now()])
  ctx.db.run("UPDATE packages SET status = 'skipped', decided_at = ? WHERE job_id = ? AND status IN ('preparing', 'ready', 'failed')", [ctx.now(), jobId])
  ctx.queue.cancel({ dedupeKey: `prepare:${jobId}` })
  ctx.bus.changed('packages', 'jobs')
}

export function skipPackage(ctx: Ctx, id: number, reason: string | null): void {
  const r = row(ctx, id)
  if (r.status === 'approved' || r.status === 'applied') throw new AppError('ALREADY_APPROVED', 'This package is already approved. Stop its run from Activity instead.', { permanent: true })
  skipJob(ctx, r.job_id, reason, r.hunt_id)
}

/** The user's answer replaces the prepared one; "save" also stores it for future forms. */
export function updateAnswer(ctx: Ctx, id: number, fieldName: string, answer: string, save: 'no' | 'all' | 'company'): PackageDetail {
  const r = row(ctx, id)
  if (r.status !== 'ready') throw new AppError('NOT_READY', 'Only a package waiting for review can be edited.', { permanent: true })
  const answers = json.parse<PreparedAnswer[]>(r.answers, [])
  const a = answers.find((x) => x.fieldName === fieldName)
  if (!a) throw new AppError('NOT_FOUND', 'That question is not on this form.', { permanent: true })
  const value = answer.trim()
  if (a.options.length && value && !a.options.includes(value)) {
    const picked = pickOption(a.options, value)
    if (!picked) throw new AppError('BAD_OPTION', `Pick one of: ${a.options.slice(0, 6).join(', ')}.`, { permanent: true })
  }
  Object.assign(a, { answer: value, source: 'user', confidence: 1, needsUser: a.required && !value })
  ctx.db.tx(() => {
    ctx.db.run('UPDATE packages SET answers = ? WHERE id = ?', [JSON.stringify(answers), id])
    if (save !== 'no' && value) {
      const companyId = save === 'company' ? (ctx.db.get<{ company_id: number | null }>('SELECT company_id FROM jobs WHERE id = ?', [r.job_id])?.company_id ?? null) : null
      bankSave(ctx.db, { key: a.key ?? questionKey(a.question), question: a.question, answer: value, kind: a.kind, companyId, source: a.source === 'generated' ? 'approved_generated' : 'user' }, ctx.now())
    }
  })
  refreshGates(ctx, id)
  ctx.bus.changed('packages', 'answers')
  return packageDetail(ctx, id)
}

export function setPackageResume(ctx: Ctx, id: number, resumeId: number): PackageDetail {
  const r = row(ctx, id)
  if (r.status !== 'ready') throw new AppError('NOT_READY', 'Only a package waiting for review can be edited.', { permanent: true })
  resumeDetail(ctx, resumeId)
  ctx.db.run('UPDATE packages SET resume_id = ? WHERE id = ?', [resumeId, id])
  refreshGates(ctx, id)
  ctx.bus.changed('packages')
  return packageDetail(ctx, id)
}

/** Throws the package away (with its tailored documents) and prepares a fresh one. */
export function regeneratePackage(ctx: Ctx, id: number): void {
  const r = row(ctx, id)
  if (r.status === 'approved' || r.status === 'applied') throw new AppError('ALREADY_APPROVED', 'This package is already approved.', { permanent: true })
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM packages WHERE id = ?', [id])
    if (r.resume_id) ctx.db.run("DELETE FROM resumes WHERE id = ? AND kind = 'tailored'", [r.resume_id])
    if (r.cover_letter_id) ctx.db.run('DELETE FROM cover_letters WHERE id = ?', [r.cover_letter_id])
  })
  ctx.queue.enqueue('packages.prepare', { jobId: r.job_id, huntId: r.hunt_id }, { dedupeKey: `prepare:${r.job_id}`, priority: 100 })
  ctx.bus.changed('packages', 'documents')
}

/** Packages for postings that closed while waiting in the Queue. */
export function expireClosed(ctx: Ctx): number {
  return ctx.db.run("UPDATE packages SET status = 'expired', decided_at = ? WHERE status IN ('ready', 'failed') AND job_id IN (SELECT id FROM jobs WHERE closed_at IS NOT NULL)", [ctx.now()]).changes
}
