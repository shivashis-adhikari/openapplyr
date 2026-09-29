import type { JobList, JobView } from '../../shared/api/jobs'
import { JOB_VIEWS } from '../../shared/api/jobs'
import type { AppStatus, H1bStats, JobDetail, JobLocation, JobScore, JobSummary, PackageStatus, Salary, Signal } from '../../shared/domain'
import { type Db, json } from '../core/db'
import { AppError } from '../core/errors'

export type ListFilter = {
  huntId: number | null
  view: JobView
  q: string
  remote: string[]
  employment: string[]
  minScore: number
  hideWarnings: boolean
  sort: 'score' | 'newest' | 'posted'
  limit: number
  offset: number
}

type Row = {
  id: number
  title: string
  company_name: string
  company_id: number | null
  location_text: string | null
  locations: string
  remote: JobSummary['remote']
  salary: string | null
  posted_at: number | null
  first_seen_at: number
  source_kind: string
  apply_ats: string | null
  signals: string
  user_state: JobSummary['userState']
  closed_at: number | null
  score: number | null
  score_hunt: number | null
  app_status: AppStatus | null
  pkg_status: PackageStatus | null
}

function locationLabel(r: { location_text: string | null; locations: string; remote: string }): string {
  const locs = json.parse<JobLocation[]>(r.locations, [])
  const first = locs[0]
  const place = first ? [first.city, first.region && first.city ? null : first.region, first.country].filter(Boolean).join(', ') : ''
  const extra = locs.length > 1 ? ` +${locs.length - 1}` : ''
  if (r.remote === 'remote') return place ? `Remote (${place}${extra})` : r.location_text?.trim() || 'Remote'
  return (place ? `${place}${extra}` : r.location_text?.trim()) || 'Location not stated'
}

function toSummary(r: Row): JobSummary {
  return {
    id: r.id,
    title: r.title,
    company: r.company_name,
    companyId: r.company_id,
    location: locationLabel(r),
    remote: r.remote,
    salary: json.parse<Salary | null>(r.salary, null),
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen_at,
    source: r.source_kind,
    ats: r.apply_ats,
    score: r.score,
    huntId: r.score_hunt,
    signals: json.parse<Signal[]>(r.signals, []),
    userState: r.user_state,
    applicationStatus: r.app_status,
    packageStatus: r.pkg_status,
    closed: r.closed_at != null,
  }
}

/** FTS5 query from free text: each word quoted, all required. */
function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}+#.]+/gu)?.slice(0, 8) ?? []
  return words.length ? words.map((w) => `"${w.replace(/"/g, '')}"`).join(' AND ') : null
}

function viewWhere(view: JobView, huntScoped: boolean): string {
  switch (view) {
    case 'matches':
      return `j.closed_at IS NULL AND (j.user_state IS NULL OR j.user_state != 'skipped') AND s.stage = 'judged' AND s.score >= h.threshold`
    case 'new':
      return `j.closed_at IS NULL AND j.first_seen_at >= :dayAgo AND (j.user_state IS NULL OR j.user_state != 'skipped')`
    case 'all':
      return `j.closed_at IS NULL`
    case 'saved':
      return `j.user_state = 'saved'`
    case 'skipped':
      return `j.user_state = 'skipped'`
    case 'filtered':
      return huntScoped ? `s.stage = 'filtered'` : `EXISTS (SELECT 1 FROM job_scores f WHERE f.job_id = j.id AND f.stage = 'filtered')`
    case 'applied':
      return `a.status IS NOT NULL`
  }
}

/**
 * Jobs for the list screen. Scores come from the selected hunt, or the best score across hunts.
 * Filters are composed as SQL; nothing loads the whole table into memory.
 */
export function listJobs(db: Db, f: ListFilter, now: number): JobList {
  const scoped = f.huntId != null
  const scoreJoin = scoped
    ? `LEFT JOIN job_scores s ON s.job_id = j.id AND s.hunt_id = :huntId
       LEFT JOIN (SELECT id, json_extract(config, '$.queueThreshold') threshold FROM hunts) h ON h.id = s.hunt_id`
    : `LEFT JOIN (SELECT job_id, stage, MAX(score) score, hunt_id FROM job_scores WHERE stage = 'judged' GROUP BY job_id) s ON s.job_id = j.id
       LEFT JOIN (SELECT id, json_extract(config, '$.queueThreshold') threshold FROM hunts) h ON h.id = s.hunt_id`
  const base = `FROM jobs j
    ${scoreJoin}
    LEFT JOIN applications a ON a.group_key = 'job:' || j.group_id AND a.archived = 0
    LEFT JOIN packages p ON p.job_id = j.id AND p.status IN ('preparing', 'ready', 'approved')`
  const params: Record<string, unknown> = { huntId: f.huntId, dayAgo: now - 86_400_000, minScore: f.minScore }
  const where: string[] = []
  const fts = f.q ? ftsQuery(f.q) : null
  if (fts) {
    where.push('j.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH :fts)')
    params['fts'] = fts
  }
  if (f.remote.length) {
    where.push(`j.remote IN (${f.remote.map((_, i) => `:r${i}`).join(', ')})`)
    f.remote.forEach((r, i) => (params[`r${i}`] = r))
  }
  if (f.employment.length) {
    where.push(`j.employment_type IN (${f.employment.map((_, i) => `:e${i}`).join(', ')})`)
    f.employment.forEach((e, i) => (params[`e${i}`] = e))
  }
  if (f.minScore > 0) where.push('s.score >= :minScore')
  if (f.hideWarnings) where.push(`NOT EXISTS (SELECT 1 FROM json_each(j.signals) WHERE json_extract(value, '$.severity') IN ('warn', 'block'))`)
  const whereFor = (view: JobView) => [viewWhere(view, scoped), ...where].join(' AND ')
  const order = f.sort === 'newest' ? 'j.first_seen_at DESC' : f.sort === 'posted' ? 'COALESCE(j.posted_at, j.first_seen_at) DESC' : 's.score IS NULL, s.score DESC, j.first_seen_at DESC'
  const rows = db.all<Row>(
    `SELECT j.id, j.title, j.company_name, j.company_id, j.location_text, j.locations, j.remote, j.salary, j.posted_at, j.first_seen_at,
            j.source_kind, j.apply_ats, j.signals, j.user_state, j.closed_at, s.score, s.hunt_id score_hunt, a.status app_status, p.status pkg_status
     ${base} WHERE ${whereFor(f.view)} ORDER BY ${order} LIMIT :limit OFFSET :offset`,
    { ...params, limit: f.limit, offset: f.offset },
  )
  const counts = {} as Record<JobView, number>
  for (const v of JOB_VIEWS) counts[v] = db.get<{ n: number }>(`SELECT COUNT(*) n ${base} WHERE ${whereFor(v)}`, params)!.n
  return { rows: rows.map(toSummary), total: counts[f.view], counts }
}

export function jobDetail(db: Db, id: number): JobDetail {
  const r = db.get<
    Row & {
      url: string
      apply_url: string | null
      description_html: string | null
      description_md: string
      employment_type: JobDetail['employmentType']
      contract_type: JobDetail['contractType']
      seniority: JobDetail['seniority']
      repost_count: number
      last_seen_at: number
      group_id: number | null
    }
  >(
    `SELECT j.*, a.status app_status, p.status pkg_status, NULL score, NULL score_hunt FROM jobs j
     LEFT JOIN applications a ON a.group_key = 'job:' || j.group_id AND a.archived = 0
     LEFT JOIN packages p ON p.job_id = j.id AND p.status IN ('preparing', 'ready', 'approved')
     WHERE j.id = ?`,
    [id],
  )
  if (!r) throw new AppError('NOT_FOUND', 'That job is no longer in your database.', { permanent: true })
  const scores = db
    .all<{ hunt_id: number; name: string; stage: JobScore['stage']; passed: number; reasons: string; score: number | null; breakdown: string | null; judgment: string | null; error: string | null }>(
      `SELECT s.hunt_id, h.name, s.stage, s.passed, s.reasons, s.score, s.breakdown, s.judgment, s.error
       FROM job_scores s JOIN hunts h ON h.id = s.hunt_id WHERE s.job_id = ? ORDER BY s.score DESC`,
      [id],
    )
    .map(
      (s): JobScore => ({
        huntId: s.hunt_id,
        huntName: s.name,
        stage: s.stage,
        passed: !!s.passed,
        reasons: json.parse(s.reasons, []),
        score: s.score,
        breakdown: json.parse(s.breakdown, null),
        judgment: json.parse(s.judgment, null),
        error: s.error,
      }),
    )
  const company = r.company_id ? db.get<{ id: number; name: string; domain: string | null; ats: string | null; h1b: string | null; blocked: number }>('SELECT * FROM companies WHERE id = ?', [r.company_id]) : null
  const openRoles = r.company_id ? db.get<{ n: number }>('SELECT COUNT(*) n FROM jobs WHERE company_id = ? AND closed_at IS NULL', [r.company_id])!.n : 0
  const watched = r.company_id ? !!db.get("SELECT 1 FROM sources WHERE company_id = ? AND origin = 'user' AND enabled = 1", [r.company_id]) : false
  const best = scores.find((s) => s.stage === 'judged')
  const app = db.get<{ id: number }>("SELECT id FROM applications WHERE group_key = 'job:' || ? AND archived = 0", [r.group_id ?? r.id])
  const pkg = db.get<{ id: number }>("SELECT id FROM packages WHERE job_id = ? ORDER BY id DESC LIMIT 1", [id])
  return {
    ...toSummary({ ...r, score: best?.score ?? null, score_hunt: best?.huntId ?? null }),
    url: r.url,
    applyUrl: r.apply_url,
    descriptionHtml: r.description_html,
    descriptionMd: r.description_md,
    employmentType: r.employment_type,
    contractType: r.contract_type,
    seniority: r.seniority,
    locations: json.parse(r.locations, []),
    repostCount: r.repost_count,
    lastSeenAt: r.last_seen_at,
    scores,
    companyInfo: {
      id: company?.id ?? null,
      name: company?.name ?? r.company_name,
      domain: company?.domain ?? null,
      ats: company?.ats ?? r.apply_ats,
      openRoles,
      h1b: json.parse<H1bStats | null>(company?.h1b, null),
      watched,
      blocked: !!company?.blocked,
    },
    applicationId: app?.id ?? null,
    packageId: pkg?.id ?? null,
  }
}
