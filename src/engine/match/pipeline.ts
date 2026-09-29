import type { Hunt, JobLocation, Judgment, Profile, Salary, Signal } from '../../shared/domain'
import { startOfDay } from '../ai/ledger'
import { json } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { ensureDetails } from '../jobs/details'
import type { JobMeta } from '../jobs/ingest'
import type { Notifier } from '../notify'
import { loadProfile } from '../profile/store'
import type { Services } from '../services'
import { type FilterJob, applyFilters } from './filters'
import { listHunts } from './hunts'
import { computeScore, judgePrompt, sanitizeJudgment } from './judge'

export type Candidate = {
  id: number
  group_id: number | null
  source_kind: string
  title: string
  title_norm: string
  company_name: string
  company_id: number | null
  blocked: number | null
  seniority: string | null
  employment_type: string | null
  contract_type: string | null
  remote: FilterJob['remote']
  locations: string
  location_text: string | null
  salary: string | null
  salary_annual_min: number | null
  salary_annual_max: number | null
  posted_at: number | null
  first_seen_at: number
  signals: string
  meta: string
}

const ATS_FIRST = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'recruitee', 'workable']

export function toFilterJob(ctx: Ctx, c: Candidate, cooldownDays: number): FilterJob {
  const meta = json.parse<JobMeta>(c.meta, {} as JobMeta)
  const recent = c.company_id
    ? ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM applications WHERE company_id = ? AND applied_at > ? AND status NOT IN ('failed', 'queued')", [c.company_id, ctx.now() - cooldownDays * 86_400_000])!.n
    : 0
  return {
    titleNorm: c.title_norm,
    title: c.title,
    company: c.company_name,
    companyBlocked: !!c.blocked,
    seniority: c.seniority,
    employment: c.employment_type,
    contract: c.contract_type,
    remote: c.remote,
    locations: json.parse<JobLocation[]>(c.locations, []),
    remoteCountries: meta.remoteCountries ?? [],
    remoteGlobal: !!meta.remoteGlobal,
    salary: json.parse<Salary | null>(c.salary, null),
    annualMin: c.salary_annual_min,
    annualMax: c.salary_annual_max,
    postedAt: c.posted_at,
    firstSeenAt: c.first_seen_at,
    signals: json.parse<Signal[]>(c.signals, []),
    recentApplicationsToCompany: recent,
  }
}

function saveScore(ctx: Ctx, jobId: number, huntId: number, v: { stage: string; passed: boolean; reasons: string[]; prefilter?: number | null; score?: number | null; breakdown?: unknown; judgment?: unknown; error?: string | null; model?: string | null }): void {
  ctx.db.run(
    `INSERT INTO job_scores (job_id, hunt_id, stage, passed, reasons, prefilter, score, breakdown, judgment, prompt_version, model, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, hunt_id) DO UPDATE SET stage = excluded.stage, passed = excluded.passed, reasons = excluded.reasons, prefilter = excluded.prefilter,
       score = excluded.score, breakdown = excluded.breakdown, judgment = excluded.judgment, prompt_version = excluded.prompt_version, model = excluded.model,
       error = excluded.error, created_at = excluded.created_at`,
    [
      jobId,
      huntId,
      v.stage,
      v.passed,
      JSON.stringify(v.reasons),
      v.prefilter ?? null,
      v.score ?? null,
      v.breakdown ? JSON.stringify(v.breakdown) : null,
      v.judgment ? JSON.stringify(v.judgment) : null,
      `${judgePrompt.id}@${judgePrompt.version}`,
      v.model ?? null,
      v.error ?? null,
      ctx.now(),
    ],
  )
}

/** Keyword overlap between the profile and each posting (FTS5 BM25; lower is better). */
function keywordRanks(ctx: Ctx, ids: number[], profile: Profile, hunt: Hunt): Map<number, number> {
  const terms = [...new Set([...profile.skills.map((s) => s.name), ...hunt.config.titles.flatMap((t) => t.split(/\s+/))])]
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 1)
    .slice(0, 60)
  const out = new Map<number, number>()
  if (!terms.length || !ids.length) return out
  const query = terms.map((t) => `"${t}"`).join(' OR ')
  try {
    for (const r of ctx.db.all<{ rowid: number; rank: number }>(
      'SELECT rowid, bm25(jobs_fts) rank FROM jobs_fts WHERE jobs_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))',
      [query, JSON.stringify(ids)],
    )) {
      out.set(r.rowid, r.rank)
    }
  } catch (err) {
    ctx.log.warn('keyword ranking failed', { err: errorMessage(err) })
  }
  return out
}

export type ScoreRun = { judged: number; filtered: number; queued: number; errors: number; stoppedForBudget: boolean }

/**
 * Scores new jobs for every active hunt. Filters run on everything; only the best keyword matches, up to the
 * hunt's daily cap, go to the model. Jobs at or above the queue threshold get an application package.
 */
export async function scoreNewJobs(ctx: Ctx, s: Services, notifier: Notifier | null, signal?: AbortSignal): Promise<ScoreRun> {
  const run: ScoreRun = { judged: 0, filtered: 0, queued: 0, errors: 0, stoppedForBudget: false }
  const { profile } = loadProfile(ctx.db)
  if (!profile.work.length) return run
  const assignment = s.ai.assignment('fast')
  let newMatches = 0
  for (const hunt of listHunts(ctx.db, true)) {
    if (signal?.aborted || run.stoppedForBudget) break
    const c = hunt.config
    const since = ctx.now() - (c.postedWithinDays + 2) * 86_400_000
    const rows = ctx.db.all<Candidate>(
      `SELECT j.id, j.group_id, j.source_kind, j.title, j.title_norm, j.company_name, j.company_id, co.blocked, j.seniority, j.employment_type,
              j.contract_type, j.remote, j.locations, j.location_text, j.salary, j.salary_annual_min, j.salary_annual_max, j.posted_at,
              j.first_seen_at, j.signals, j.meta
       FROM jobs j
       LEFT JOIN companies co ON co.id = j.company_id
       LEFT JOIN job_scores js ON js.job_id = j.id AND js.hunt_id = ?
       WHERE j.closed_at IS NULL AND COALESCE(j.posted_at, j.first_seen_at) >= ? AND (j.user_state IS NULL OR j.user_state != 'skipped')
         AND (js.job_id IS NULL OR (js.stage = 'error' AND js.created_at < ?))
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.group_key = 'job:' || j.group_id AND a.archived = 0)
       ORDER BY j.first_seen_at DESC LIMIT 3000`,
      [hunt.id, since, ctx.now() - 3600_000],
    )
    // One representative per job group: prefer the direct ATS posting.
    const byGroup = new Map<number, Candidate>()
    for (const r of rows) {
      const g = r.group_id ?? r.id
      const cur = byGroup.get(g)
      const rank = (x: Candidate) => (ATS_FIRST.includes(x.source_kind) ? 0 : 1)
      if (!cur || rank(r) < rank(cur)) byGroup.set(g, r)
    }
    const passing: Candidate[] = []
    ctx.db.tx(() => {
      for (const r of rows) {
        const rep = byGroup.get(r.group_id ?? r.id)!
        if (rep.id !== r.id) {
          saveScore(ctx, r.id, hunt.id, { stage: 'filtered', passed: false, reasons: [`Same role as another posting from ${rep.source_kind}; that one is scored instead.`] })
          continue
        }
        const f = applyFilters(toFilterJob(ctx, r, c.companyCooldown.days), c, profile, ctx.now())
        if (!f.passed) {
          saveScore(ctx, r.id, hunt.id, { stage: 'filtered', passed: false, reasons: f.reasons })
          run.filtered++
        } else passing.push(r)
      }
    })
    const judgedToday = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM job_scores WHERE hunt_id = ? AND stage = 'judged' AND created_at >= ?", [hunt.id, startOfDay(ctx.now())])!.n
    const budget = Math.max(0, c.dailyScoreCap - judgedToday)
    const ranks = keywordRanks(ctx, passing.map((p) => p.id), profile, hunt)
    const chosen = passing.sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0)).slice(0, budget)
    for (const job of chosen) {
      if (signal?.aborted) break
      const ok = await ensureDetails(ctx, job.id, signal)
      const fresh = ctx.db.get<Candidate & { description_md: string }>(
        `SELECT j.*, co.blocked FROM jobs j LEFT JOIN companies co ON co.id = j.company_id WHERE j.id = ?`,
        [job.id],
      )!
      if (ok) {
        const f = applyFilters(toFilterJob(ctx, fresh, c.companyCooldown.days), c, profile, ctx.now())
        if (!f.passed) {
          saveScore(ctx, job.id, hunt.id, { stage: 'filtered', passed: false, reasons: f.reasons })
          run.filtered++
          continue
        }
      }
      if (!fresh.description_md.trim()) {
        saveScore(ctx, job.id, hunt.id, { stage: 'error', passed: true, reasons: [], error: 'The posting text could not be loaded.' })
        run.errors++
        continue
      }
      try {
        const raw = await s.ai.structured(
          judgePrompt,
          { profile, title: fresh.title, company: fresh.company_name, location: fresh.location_text ?? '', description: fresh.description_md, wantedTitles: c.titles },
          { task: 'Score job', signal },
        )
        const judgment: Judgment = sanitizeJudgment(raw, profile)
        const breakdown = computeScore(judgment)
        saveScore(ctx, job.id, hunt.id, {
          stage: 'judged',
          passed: true,
          reasons: [],
          prefilter: ranks.get(job.id) ?? null,
          score: breakdown.total,
          breakdown,
          judgment,
          model: assignment ? `${assignment.kind}/${assignment.modelId}` : null,
        })
        run.judged++
        if (breakdown.total >= c.queueThreshold) {
          newMatches++
          if (hunt.mode !== 'manual') {
            ctx.queue.enqueue('packages.prepare', { jobId: job.id, huntId: hunt.id }, { dedupeKey: `prepare:${job.id}`, priority: Math.round(breakdown.total) })
            run.queued++
          }
        }
      } catch (err) {
        if (err instanceof AppError && err.code === 'BUDGET') {
          run.stoppedForBudget = true
          break
        }
        if (err instanceof AppError && (err.code === 'NO_MODEL' || err.code === 'AUTH' || err.code === 'QUOTA')) throw err
        saveScore(ctx, job.id, hunt.id, { stage: 'error', passed: true, reasons: [], error: errorMessage(err) })
        run.errors++
      }
    }
    ctx.db.run('UPDATE hunts SET last_run_at = ? WHERE id = ?', [ctx.now(), hunt.id])
  }
  if (newMatches) notifier?.matches(newMatches)
  if (run.judged || run.filtered) ctx.bus.changed('jobs', 'hunts')
  return run
}
