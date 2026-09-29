import type { AppStatus } from '../../shared/domain'
import type { Db } from '../core/db'
import { AppError } from '../core/errors'

export type EventSource = 'app' | 'user' | 'run' | 'mail' | 'import' | 'rule'

export function addEvent(db: Db, applicationId: number, type: string, source: EventSource, data: Record<string, unknown>, at: number): void {
  db.run('INSERT INTO events (application_id, type, at, source, data) VALUES (?, ?, ?, ?, ?)', [applicationId, type, at, source, JSON.stringify(data)])
  db.run('UPDATE applications SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?', [at, applicationId])
}

export type NewApplication = {
  jobId: number | null
  groupKey: string
  companyId: number | null
  company: string
  title: string
  huntId: number | null
  packageId: number | null
  status: AppStatus
  channel: 'ats' | 'email' | 'referral' | 'other'
  url: string | null
  appliedAt?: number | null
  source: EventSource
}

/** One live application per job group (a partial unique index enforces it); archive the old one to reapply. */
export function createApplication(db: Db, a: NewApplication, now: number): number {
  const live = db.get<{ id: number; status: string }>('SELECT id, status FROM applications WHERE group_key = ? AND archived = 0', [a.groupKey])
  if (live) throw new AppError('ALREADY_APPLIED', `You already have an application for ${a.title} at ${a.company}. Archive it first to apply again.`, { permanent: true, detail: String(live.id) })
  const id = db.run(
    `INSERT INTO applications (job_id, group_key, company_id, company_name, title, hunt_id, package_id, status, channel, url, applied_at, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.jobId, a.groupKey, a.companyId, a.company, a.title, a.huntId, a.packageId, a.status, a.channel, a.url, a.appliedAt ?? null, now, now],
  ).lastInsertRowid
  addEvent(db, id, 'created', a.source, { status: a.status }, now)
  return id
}

/**
 * Where each status sits in the pipeline. Automatic sources (mail, rules, the apply engine
 * after the fact) only move an application forward or to a closing state; the user can set anything.
 */
const RANK: Record<AppStatus, number> = {
  queued: 0,
  applying: 1,
  needs_user: 1,
  failed: 1,
  applied_unverified: 2,
  applied: 2,
  ghosted: 2,
  screening: 3,
  interviewing: 4,
  offer: 5,
  accepted: 6,
  declined: 6,
  rejected: 6,
  withdrawn: 6,
}
const FINAL: AppStatus[] = ['accepted', 'declined', 'withdrawn']

export function canMove(from: AppStatus, to: AppStatus, source: EventSource): boolean {
  if (from === to) return false
  if (source === 'user') return true
  if (FINAL.includes(from)) return false
  if (to === 'rejected') return RANK[from] >= 2 && from !== 'rejected'
  if (to === 'ghosted') return from === 'applied' || from === 'applied_unverified'
  if (from === 'rejected') return false
  return RANK[to] > RANK[from] || (from === 'applied_unverified' && to === 'applied')
}

/** Changes status with an event naming its source and evidence. Returns false when the move is not allowed. */
export function setStatus(db: Db, id: number, to: AppStatus, source: EventSource, data: Record<string, unknown>, now: number): boolean {
  const app = db.get<{ status: AppStatus; applied_at: number | null }>('SELECT status, applied_at FROM applications WHERE id = ?', [id])
  if (!app) throw new AppError('NOT_FOUND', 'That application no longer exists.', { permanent: true })
  if (!canMove(app.status, to, source)) return false
  db.tx(() => {
    const appliedAt = app.applied_at ?? (RANK[to] >= 2 && !['ghosted', 'withdrawn'].includes(to) ? now : null)
    db.run('UPDATE applications SET status = ?, applied_at = ? WHERE id = ?', [to, appliedAt, id])
    addEvent(db, id, 'status', source, { from: app.status, to, ...data }, now)
  })
  return true
}
