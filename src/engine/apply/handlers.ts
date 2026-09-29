import type { PreparedAnswer, RunDetail, RunMode, RunStatus, RunStep, RunSummary } from '../../shared/domain'
import { bankSave, questionKey } from '../answers/resolve'
import { json } from '../core/db'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import type { Notifier } from '../notify'
import type { Services } from '../services'
import { BrowserManager } from './browser'
import { type ApplyPayload, ApplyService, evidenceFiles } from './run'

type RunRow = {
  id: number
  application_id: number | null
  job_id: number | null
  adapter: string | null
  mode: RunMode
  status: RunStatus
  question: string | null
  error: string | null
  steps: string
  started_at: number
  ended_at: number | null
  title: string | null
  company_name: string | null
  field_name: string | null
}

// The field a waiting run asked about comes from its latest needs-user event.
const SELECT = `SELECT r.*, a.title, a.company_name,
  (SELECT json_extract(e.data, '$.fieldName') FROM events e WHERE e.application_id = r.application_id AND e.type = 'needs_user' AND json_extract(e.data, '$.runId') = r.id ORDER BY e.id DESC LIMIT 1) field_name
  FROM runs r LEFT JOIN applications a ON a.id = r.application_id`

const summary = (r: RunRow): RunSummary => ({
  id: r.id,
  applicationId: r.application_id,
  jobId: r.job_id,
  title: r.title ?? '',
  company: r.company_name ?? '',
  adapter: r.adapter,
  mode: r.mode,
  status: r.status,
  question: r.question,
  fieldName: r.field_name,
  error: r.error,
  startedAt: r.started_at,
  endedAt: r.ended_at,
})

/** Saves a mid-run answer where the next attempt will find it: the package, and the answer bank when asked. */
function keepAnswer(ctx: Ctx, applicationId: number, fieldName: string, answer: string, save: 'no' | 'all' | 'company'): void {
  const app = ctx.db.get<{ package_id: number | null; company_id: number | null }>('SELECT package_id, company_id FROM applications WHERE id = ?', [applicationId])
  if (!app) return
  const asked = ctx.db.get<{ data: string }>("SELECT data FROM events WHERE application_id = ? AND type = 'needs_user' ORDER BY id DESC LIMIT 1", [applicationId])
  const label = json.parse<{ label?: string | null }>(asked?.data, {}).label ?? fieldName
  if (app.package_id) {
    const row = ctx.db.get<{ answers: string }>('SELECT answers FROM packages WHERE id = ?', [app.package_id])
    const answers = json.parse<PreparedAnswer[]>(row?.answers, [])
    const existing = answers.find((a) => a.fieldName === fieldName)
    if (existing) Object.assign(existing, { answer, source: 'user', needsUser: false, confidence: 1 })
    else answers.push({ fieldName, question: label, key: null, kind: 'fact', required: true, options: [], answer, source: 'user', confidence: 1, needsUser: false })
    ctx.db.run('UPDATE packages SET answers = ? WHERE id = ?', [JSON.stringify(answers), app.package_id])
  }
  if (save !== 'no') bankSave(ctx.db, { key: questionKey(label), question: label, answer, kind: 'fact', companyId: save === 'company' ? app.company_id : null, source: 'user' }, ctx.now())
}

export function runsFor(ctx: Ctx, applicationId: number): RunSummary[] {
  return ctx.db.all<RunRow>(`${SELECT} WHERE r.application_id = ? ORDER BY r.started_at DESC`, [applicationId]).map(summary)
}

export function registerApplyHandlers(ctx: Ctx, s: Services, notifier: Notifier | null, browser = new BrowserManager(ctx)): ApplyService {
  const service = new ApplyService(ctx, s, notifier, browser)
  const { router, db } = ctx

  router.on('runs.list', ({ filter, applicationId }) =>
    db
      .all<RunRow>(
        `${SELECT} WHERE ${filter === 'active' ? "r.status IN ('running', 'needs_user')" : '1 = 1'} ${applicationId ? 'AND r.application_id = ?' : ''} ORDER BY r.started_at DESC LIMIT 200`,
        applicationId ? [applicationId] : [],
      )
      .map(summary),
  )

  router.on('runs.get', ({ id }): RunDetail => {
    const r = db.get<RunRow>(`${SELECT} WHERE r.id = ?`, [id])
    if (!r) throw new AppError('NOT_FOUND', 'That run no longer exists.', { permanent: true })
    const dir = r.application_id ? `${ctx.paths.evidence}/${r.application_id}/${r.id}` : null
    return { ...summary(r), steps: json.parse<RunStep[]>(r.steps, []), evidence: evidenceFiles(dir) }
  })

  router.on('runs.reply', ({ id, reply }) => {
    const r = db.get<{ application_id: number | null; status: string }>('SELECT application_id, status FROM runs WHERE id = ?', [id])
    if (!r?.application_id) throw new AppError('NOT_FOUND', 'That run no longer exists.', { permanent: true })
    if (reply.kind === 'answer') keepAnswer(ctx, r.application_id, reply.fieldName, reply.answer, reply.save)
    if (service.reply(id, reply.kind === 'answer' ? { kind: 'answer', fieldName: reply.fieldName, answer: reply.answer } : { kind: 'continue' })) return null
    // The run gave up waiting; start it again now that the answer is saved.
    ctx.queue.enqueue('apply.run', { applicationId: r.application_id, manual: true } satisfies ApplyPayload, { dedupeKey: `apply:${r.application_id}`, priority: 100 })
    db.run("UPDATE applications SET status = 'queued' WHERE id = ?", [r.application_id])
    ctx.bus.changed('applications', 'runs')
    return null
  })

  router.on('runs.stop', ({ id }) => {
    if (!service.stop(id)) throw new AppError('NOT_RUNNING', 'That run is not running.', { permanent: true })
    return null
  })

  router.on('applications.run', ({ id, mode }) => {
    const app = db.get<{ status: string; archived: number }>('SELECT status, archived FROM applications WHERE id = ?', [id])
    if (!app) throw new AppError('NOT_FOUND', 'That application no longer exists.', { permanent: true })
    if (['applied', 'applied_unverified'].includes(app.status)) throw new AppError('ALREADY_APPLIED', 'This application was already sent.', { permanent: true })
    db.run("UPDATE applications SET status = 'queued' WHERE id = ?", [id])
    ctx.queue.enqueue('apply.run', { applicationId: id, mode: mode ?? 'submit', manual: true } satisfies ApplyPayload, { dedupeKey: `apply:${id}`, priority: 100 })
    ctx.bus.changed('applications')
    return null
  })

  const concurrency = ctx.settings.get().automation.concurrency
  ctx.worker.register('apply.run', (payload, t) => service.run(payload as ApplyPayload, t.signal, t.attempt), { concurrency, timeoutMs: 3 * 3600_000 })
  return service
}
