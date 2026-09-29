import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { RunSummary } from '../../shared/domain'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { companyKey, titleKey } from '../jobs/classify'
import { upsertCompany } from '../jobs/ingest'
import { addEvent, createApplication, setStatus } from './applications'
import { analytics } from './analytics'
import { exportApplications, importApplications, previewImport } from './csv'
import { applicationDetail, listApplications } from './queries'

const MAX_IMPORT_BYTES = 20 * 1024 * 1024

function readImport(path: string): string {
  if (statSync(path).size > MAX_IMPORT_BYTES) throw new AppError('TOO_LARGE', 'That file is over 20 MB. Split it and import the parts.', { permanent: true })
  return readFileSync(path, 'utf8')
}

export function registerTrackerHandlers(ctx: Ctx, runsFor: (appId: number) => RunSummary[]): void {
  const { router, db } = ctx
  const changed = () => ctx.bus.changed('applications')

  router.on('applications.list', (f) => listApplications(db, f))
  router.on('applications.get', ({ id }) => applicationDetail(db, id, runsFor))

  router.on('applications.setStatus', ({ ids, status, note }) => {
    for (const id of ids) setStatus(db, id, status, 'user', note ? { note } : {}, ctx.now())
    if (['rejected', 'withdrawn', 'offer', 'interviewing', 'accepted', 'declined'].includes(status)) {
      // Follow-ups stop once the outcome is known.
      db.run(`UPDATE outreach SET status = 'cancelled' WHERE status = 'scheduled' AND application_id IN (${ids.map(() => '?').join(',')})`, ids)
    }
    changed()
    return null
  })

  router.on('applications.update', ({ id, notes, url }) => {
    if (notes !== undefined) db.run('UPDATE applications SET notes = ? WHERE id = ?', [notes, id])
    if (url !== undefined) db.run('UPDATE applications SET url = ? WHERE id = ?', [url, id])
    changed()
    return null
  })

  router.on('applications.add', (a) => {
    const job = a.jobId ? db.get<{ group_id: number | null; company_id: number | null }>('SELECT group_id, company_id FROM jobs WHERE id = ?', [a.jobId]) : undefined
    const appliedAt = a.appliedAt ?? (a.status === 'queued' ? null : ctx.now())
    const id = createApplication(
      db,
      {
        jobId: a.jobId,
        groupKey: job ? `job:${job.group_id ?? a.jobId}` : `manual:${companyKey(a.company)}:${titleKey(a.title)}`,
        companyId: job?.company_id ?? upsertCompany(db, a.company, { now: ctx.now() }),
        company: a.company,
        title: a.title,
        huntId: null,
        packageId: null,
        status: a.status,
        channel: a.channel,
        url: a.url,
        appliedAt,
        source: 'user',
      },
      ctx.now(),
    )
    db.run("UPDATE applications SET notes = ?, method = 'manual' WHERE id = ?", [a.notes, id])
    if (a.jobId) db.run("UPDATE jobs SET user_state = 'applied' WHERE id = ?", [a.jobId])
    changed()
    return { id }
  })

  router.on('applications.archive', ({ ids, archived }) => {
    for (const id of ids) {
      try {
        db.run('UPDATE applications SET archived = ? WHERE id = ?', [archived ? 1 : 0, id])
        addEvent(db, id, archived ? 'archived' : 'unarchived', 'user', {}, ctx.now())
      } catch {
        throw new AppError('ALREADY_APPLIED', 'Another live application exists for this job. Archive that one first.', { permanent: true })
      }
    }
    changed()
    return null
  })

  router.on('applications.export', ({ format, path }) => {
    writeFileSync(path, exportApplications(db, format))
    return { path }
  })
  router.on('applications.importPreview', ({ path }) => previewImport(readImport(path)))
  router.on('applications.import', ({ path, mapping }) => {
    const region = ctx.settings.get().region
    const r = importApplications(db, readImport(path), mapping, ctx.now(), region === 'US' || region === 'CA')
    changed()
    return r
  })

  router.on('analytics.summary', ({ range }) => analytics(db, range === 'all' ? null : ctx.now() - (range === '30d' ? 30 : 90) * 86_400_000, ctx.now()))
}
