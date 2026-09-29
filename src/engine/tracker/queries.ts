import type { ApplicationDetail, ApplicationSummary, AppStatus, Interview, RunSummary, TimelineEvent } from '../../shared/domain'
import { json } from '../core/db'
import type { Db } from '../core/db'
import { AppError } from '../core/errors'

type AppRow = {
  id: number
  job_id: number | null
  company_name: string
  title: string
  status: AppStatus
  channel: string
  method: string | null
  applied_at: number | null
  last_activity_at: number
  hunt_name: string | null
  archived: number
  url: string | null
  notes: string
  confirmation: string | null
  evidence_dir: string | null
  package_id: number | null
  resume_id: number | null
  cover_letter_id: number | null
}

const SELECT = `SELECT a.*, h.name hunt_name, p.resume_id, p.cover_letter_id
  FROM applications a LEFT JOIN hunts h ON h.id = a.hunt_id LEFT JOIN packages p ON p.id = a.package_id`

const summary = (r: AppRow): ApplicationSummary => ({
  id: r.id,
  jobId: r.job_id,
  company: r.company_name,
  title: r.title,
  status: r.status,
  channel: r.channel,
  method: r.method,
  appliedAt: r.applied_at,
  lastActivityAt: r.last_activity_at,
  huntName: r.hunt_name,
  archived: !!r.archived,
  url: r.url,
})

export type AppFilter = { q: string; statuses: AppStatus[]; huntId: number | null; archived: boolean }

export function listApplications(db: Db, f: AppFilter): ApplicationSummary[] {
  const where = ['a.archived = ?']
  const args: (string | number)[] = [f.archived ? 1 : 0]
  if (f.q.trim()) {
    where.push('(a.company_name LIKE ? OR a.title LIKE ? OR a.notes LIKE ?)')
    const like = `%${f.q.trim().replace(/[%_]/g, '')}%`
    args.push(like, like, like)
  }
  if (f.statuses.length) {
    where.push(`a.status IN (${f.statuses.map(() => '?').join(', ')})`)
    args.push(...f.statuses)
  }
  if (f.huntId !== null) {
    where.push('a.hunt_id = ?')
    args.push(f.huntId)
  }
  return db.all<AppRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.last_activity_at DESC LIMIT 5000`, args).map(summary)
}

export function applicationDetail(db: Db, id: number, runs: (appId: number) => RunSummary[]): ApplicationDetail {
  const r = db.get<AppRow>(`${SELECT} WHERE a.id = ?`, [id])
  if (!r) throw new AppError('NOT_FOUND', 'That application no longer exists.', { permanent: true })
  const timeline = db
    .all<{ id: number; type: string; at: number; source: string; data: string }>('SELECT id, type, at, source, data FROM events WHERE application_id = ? ORDER BY at, id', [id])
    .map((e): TimelineEvent => ({ id: e.id, type: e.type, at: e.at, source: e.source, data: json.parse(e.data, {}) }))
  const contacts = db.all<{ id: number; name: string; title: string | null; email: string | null }>(
    `SELECT DISTINCT c.id, c.name, c.title, c.email FROM contacts c JOIN outreach o ON o.contact_id = c.id WHERE o.application_id = ? ORDER BY c.name`,
    [id],
  )
  const interviews = db
    .all<{ id: number; application_id: number | null; starts_at: number | null; ends_at: number | null; kind: Interview['kind']; location: string | null; link: string | null; interviewers: string; notes: string }>(
      'SELECT * FROM interviews WHERE application_id = ? ORDER BY starts_at',
      [id],
    )
    .map((i): Interview => ({ id: i.id, applicationId: i.application_id, startsAt: i.starts_at, endsAt: i.ends_at, kind: i.kind, location: i.location, link: i.link, interviewers: json.parse(i.interviewers, []), notes: i.notes, company: r.company_name, title: r.title }))
  return {
    ...summary(r),
    notes: r.notes,
    confirmation: json.parse(r.confirmation, null),
    evidenceDir: r.evidence_dir,
    timeline,
    runs: runs(id),
    resumeId: r.resume_id,
    coverLetterId: r.cover_letter_id,
    packageId: r.package_id,
    contacts,
    interviews,
  }
}
