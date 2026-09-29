import type { SavedAnswer } from '../../shared/api/packages'
import type { AnswerKind } from '../../shared/domain'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { huntFor } from '../match/hunts'
import type { Services } from '../services'
import { preparePackage, retryable, shouldAutoApprove } from './prepare'
import { approvePackage, listPackages, packageDetail, regeneratePackage, setPackageResume, skipPackage, updateAnswer } from './store'

type AnswerRow = { id: number; key: string; question: string; answer: string; kind: AnswerKind; company: string | null; source: string; used_count: number; updated_at: number }

function listAnswers(ctx: Ctx, q: string): SavedAnswer[] {
  const like = `%${q.replace(/[%_]/g, '')}%`
  return ctx.db
    .all<AnswerRow>(
      `SELECT a.id, a.key, a.question, a.answer, a.kind, c.name company, a.source, a.used_count, a.updated_at
       FROM answers a LEFT JOIN companies c ON c.id = a.scope_company_id
       WHERE ? = '' OR a.question LIKE ? OR a.answer LIKE ?
       ORDER BY a.updated_at DESC LIMIT 1000`,
      [q, like, like],
    )
    .map((r) => ({ id: r.id, key: r.key, question: r.question, answer: r.answer, kind: r.kind, company: r.company, source: r.source, usedCount: r.used_count, updatedAt: r.updated_at }))
}

/** Prepares one package; in autopilot, a package that passes every gate is approved straight away. */
export async function runPrepare(ctx: Ctx, s: Services, jobId: number, huntId: number | null, signal?: AbortSignal): Promise<number> {
  const id = await preparePackage(ctx, s, jobId, huntId, signal)
  const hunt = huntFor(ctx.db, huntId)
  const row = ctx.db.get<{ status: string; gates: string }>('SELECT status, gates FROM packages WHERE id = ?', [id])
  if (row?.status === 'ready' && shouldAutoApprove(hunt.mode, row.gates)) {
    try {
      approvePackage(ctx, id, 'autopilot')
    } catch (err) {
      // Already applied to this role through another posting, for example. The package stays in the Queue.
      ctx.db.run('UPDATE packages SET error = ? WHERE id = ?', [errorMessage(err), id])
    }
  }
  return id
}

export function registerPackageHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx

  router.on('packages.list', ({ filter }) => listPackages(ctx, filter))
  router.on('packages.get', ({ id }) => packageDetail(ctx, id))
  router.on('packages.prepareNow', ({ jobId, huntId }) => {
    ctx.queue.enqueue('packages.prepare', { jobId, huntId }, { dedupeKey: `prepare:${jobId}`, priority: 100 })
    ctx.bus.changed('packages')
    return { queued: true }
  })
  router.on('packages.approve', ({ id, mode }) => ({ applicationId: approvePackage(ctx, id, 'user', mode) }))
  router.on('packages.approveMany', ({ ids }) => {
    const approved: number[] = []
    const failed: { id: number; message: string }[] = []
    for (const id of ids) {
      try {
        approvePackage(ctx, id, 'user')
        approved.push(id)
      } catch (err) {
        failed.push({ id, message: errorMessage(err) })
      }
    }
    return { approved, failed }
  })
  router.on('packages.skip', ({ id, reason }) => {
    skipPackage(ctx, id, reason)
    return null
  })
  router.on('packages.updateAnswer', ({ id, fieldName, answer, save }) => updateAnswer(ctx, id, fieldName, answer, save))
  router.on('packages.setResume', ({ id, resumeId }) => setPackageResume(ctx, id, resumeId))
  router.on('packages.regenerate', ({ id }) => {
    regeneratePackage(ctx, id)
    return null
  })

  router.on('answers.list', ({ q }) => listAnswers(ctx, q))
  router.on('answers.save', ({ id, answer }) => {
    const r = db.run("UPDATE answers SET answer = ?, source = 'user', updated_at = ? WHERE id = ?", [answer, ctx.now(), id])
    if (!r.changes) throw new AppError('NOT_FOUND', 'That saved answer no longer exists.', { permanent: true })
    ctx.bus.changed('answers')
    return listAnswers(ctx, '')
  })
  router.on('answers.delete', ({ id }) => {
    db.run('DELETE FROM answers WHERE id = ?', [id])
    ctx.bus.changed('answers')
    return null
  })

  ctx.worker.register(
    'packages.prepare',
    async (payload, t) => {
      const { jobId, huntId } = payload as { jobId: number; huntId: number | null }
      try {
        await runPrepare(ctx, s, jobId, huntId ?? null, t.signal)
      } catch (err) {
        // Transient failures retry through the queue; anything else leaves a failed package with the reason.
        if (retryable(err) && t.attempt < 3) throw err
        ctx.log.warn('package failed', { jobId, err: errorMessage(err) })
      }
    },
    { concurrency: 2, timeoutMs: 10 * 60_000 },
  )
}
