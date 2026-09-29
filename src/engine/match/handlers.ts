import type { HuntPreview, IntegrationInfo, WatchedSource } from '../../shared/api/jobs'
import type { HuntStats } from '../../shared/domain'
import { startOfDay } from '../ai/ledger'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { type IntegrationKind, IntegrationKindSchema, credentials, deleteIntegration, listIntegrations, saveIntegration } from '../integrations'
import { importText, importUrl } from '../jobs/import'
import { jobDetail, listJobs } from '../jobs/queries'
import { loadProfile } from '../profile/store'
import { skipJob } from '../packages/store'
import { resolvePlace } from '../jobs/geo'
import type { Services } from '../services'
import { ensureAggregators, watchUrl } from '../sources/registry'
import { FILTER_LABELS, applyFilters } from './filters'
import { huntSuggestions, titleIdeasPrompt } from './feedback'
import { getHunt, listHunts, saveHunt } from './hunts'
import { computeScore, judgePrompt, sanitizeJudgment } from './judge'
import { type Candidate, toFilterJob } from './pipeline'

export function huntStats(ctx: Ctx, huntId: number): HuntStats {
  const day = startOfDay(ctx.now())
  const one = (sql: string, p: unknown[]) => ctx.db.get<{ n: number | null }>(sql, p)!.n ?? 0
  return {
    huntId,
    matched: one(
      `SELECT COUNT(*) n FROM job_scores s JOIN hunts h ON h.id = s.hunt_id JOIN jobs j ON j.id = s.job_id
       WHERE s.hunt_id = ? AND s.stage = 'judged' AND s.score >= json_extract(h.config, '$.queueThreshold') AND j.closed_at IS NULL`,
      [huntId],
    ),
    queued: one("SELECT COUNT(*) n FROM packages WHERE hunt_id = ? AND status = 'ready'", [huntId]),
    appliedToday: one("SELECT COUNT(*) n FROM applications WHERE hunt_id = ? AND applied_at >= ?", [huntId, day]),
    filteredOut: one("SELECT COUNT(*) n FROM job_scores WHERE hunt_id = ? AND stage = 'filtered'", [huntId]),
    spendToday: one("SELECT SUM(cost) n FROM packages WHERE hunt_id = ? AND created_at >= ?", [huntId, day]),
  }
}

export function registerDiscoveryHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx

  router.on('jobs.list', (f) => listJobs(db, f, ctx.now()))
  router.on('jobs.get', ({ id }) => jobDetail(db, id))

  router.on('jobs.setState', ({ id, state, reason, huntId }) => {
    if (state === 'skipped') skipJob(ctx, id, reason ?? null, huntId ?? null)
    else {
      const r = db.run('UPDATE jobs SET user_state = ?, skip_reason = NULL WHERE id = ?', [state, id])
      if (!r.changes) throw new AppError('NOT_FOUND', 'That job is no longer in your database.', { permanent: true })
    }
    ctx.bus.changed('jobs')
    return null
  })

  router.on('jobs.importUrl', async ({ url }) => {
    const id = await importUrl(ctx, s, url)
    ctx.queue.enqueue('match.score', {}, { dedupeKey: 'match.score' })
    ctx.bus.changed('jobs')
    return { id }
  })
  router.on('jobs.importText', async ({ text, url }) => {
    const id = await importText(ctx, s, text, url)
    ctx.queue.enqueue('match.score', {}, { dedupeKey: 'match.score' })
    ctx.bus.changed('jobs')
    return { id }
  })

  router.on('jobs.rescore', async ({ id, huntId }) => {
    const hunt = getHunt(db, huntId)
    const { profile } = loadProfile(db)
    const j = db.get<{ title: string; company_name: string; location_text: string | null; description_md: string }>('SELECT title, company_name, location_text, description_md FROM jobs WHERE id = ?', [id])
    if (!j) throw new AppError('NOT_FOUND', 'That job is no longer in your database.', { permanent: true })
    const judgment = sanitizeJudgment(
      await s.ai.structured(judgePrompt, { profile, title: j.title, company: j.company_name, location: j.location_text ?? '', description: j.description_md, wantedTitles: hunt.config.titles }, { task: 'Score job' }),
      profile,
    )
    const breakdown = computeScore(judgment)
    db.run(
      `INSERT INTO job_scores (job_id, hunt_id, stage, passed, reasons, score, breakdown, judgment, prompt_version, created_at)
       VALUES (?, ?, 'judged', 1, '[]', ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, hunt_id) DO UPDATE SET stage = 'judged', passed = 1, reasons = '[]', score = excluded.score, breakdown = excluded.breakdown,
         judgment = excluded.judgment, prompt_version = excluded.prompt_version, error = NULL, created_at = excluded.created_at`,
      [id, huntId, breakdown.total, JSON.stringify(breakdown), JSON.stringify(judgment), `${judgePrompt.id}@${judgePrompt.version}`, ctx.now()],
    )
    ctx.bus.changed('jobs')
    return { huntId, huntName: hunt.name, stage: 'judged', passed: true, reasons: [], score: breakdown.total, breakdown, judgment, error: null }
  })

  router.on('companies.setBlocked', ({ id, blocked }) => {
    db.run('UPDATE companies SET blocked = ? WHERE id = ?', [blocked, id])
    ctx.bus.changed('jobs')
    return null
  })

  router.on('sources.watch', ({ url }) => {
    const r = watchUrl(ctx, url)
    ctx.queue.enqueue('sources.poll', { id: r.sourceId }, { dedupeKey: `poll:${r.sourceId}`, priority: 5 })
    ctx.worker.kick()
    ctx.bus.changed('sources')
    return r
  })

  router.on('sources.list', ({ origin, limit }) =>
    db
      .all<{ id: number; kind: string; label: string; key: string; origin: string; enabled: number; job_count: number; last_ok_at: number | null; last_error: string | null; consecutive_errors: number }>(
        `SELECT id, kind, label, key, origin, enabled, job_count, last_ok_at, last_error, consecutive_errors FROM sources
         ${origin === 'all' ? '' : 'WHERE origin = ?'} ORDER BY label COLLATE NOCASE LIMIT ?`,
        origin === 'all' ? [limit] : [origin, limit],
      )
      .map(
        (r): WatchedSource => ({
          id: r.id,
          kind: r.kind,
          label: r.label,
          key: r.key,
          origin: r.origin,
          enabled: !!r.enabled,
          jobCount: r.job_count,
          lastOkAt: r.last_ok_at,
          lastError: r.last_error,
          consecutiveErrors: r.consecutive_errors,
        }),
      ),
  )
  router.on('sources.setEnabled', ({ id, enabled }) => {
    const src = db.get<{ kind: string; origin: string }>('SELECT kind, origin FROM sources WHERE id = ?', [id])
    if (!src) throw new AppError('NOT_FOUND', 'That source no longer exists.', { permanent: true })
    db.run('UPDATE sources SET enabled = ?, next_poll_at = 0 WHERE id = ?', [enabled, id])
    if (src.origin === 'builtin') ctx.settings.update({ discovery: { aggregators: { ...ctx.settings.get().discovery.aggregators, [src.kind]: enabled } } })
    ctx.bus.changed('sources')
    return null
  })
  router.on('sources.pollNow', ({ id }) => {
    ctx.queue.enqueue('sources.poll', { id }, { dedupeKey: `poll:${id}`, priority: 5 })
    ctx.worker.kick()
    return null
  })
  router.on('sources.remove', ({ id }) => {
    const r = db.run("DELETE FROM sources WHERE id = ? AND origin IN ('user', 'import')", [id])
    if (!r.changes) throw new AppError('NOT_REMOVABLE', 'Only companies you added can be removed. Turn others off instead.', { permanent: true })
    ctx.bus.changed('sources')
    return null
  })

  const integrationList = (): IntegrationInfo[] => listIntegrations(ctx)
  router.on('integrations.list', integrationList)
  router.on('integrations.save', ({ kind, values, enabled }) => {
    const k = IntegrationKindSchema.parse(kind) as IntegrationKind
    saveIntegration(ctx, k, values, enabled)
    ensureAggregators(ctx, credentials(ctx))
    ctx.bus.changed('sources', 'settings')
    return integrationList()
  })
  router.on('integrations.delete', ({ kind }) => {
    deleteIntegration(ctx, IntegrationKindSchema.parse(kind) as IntegrationKind)
    ensureAggregators(ctx, credentials(ctx))
    ctx.bus.changed('sources', 'settings')
    return integrationList()
  })

  router.on('hunts.list', () => listHunts(db).map((hunt) => ({ hunt, stats: huntStats(ctx, hunt.id) })))
  router.on('hunts.get', ({ id }) => getHunt(db, id))
  router.on('hunts.save', (input) => {
    const before = input.id ? getHunt(db, input.id) : null
    // Places typed as text ("Lisbon, Portugal") get coordinates so distance filters work.
    const places = input.config.places
      .filter((p) => p.label.trim())
      .map((p) => {
        if (p.lat !== null && p.lon !== null) return p
        const loc = resolvePlace(p.label)
        return { ...p, city: loc.city ?? p.city, country: loc.country ?? p.country, lat: loc.lat, lon: loc.lon }
      })
    const hunt = saveHunt(db, { ...input, config: { ...input.config, places } }, ctx.now())
    // Changed filters: forget old rejections so every job is checked against the new rules.
    if (before && JSON.stringify(before.config) !== JSON.stringify(hunt.config)) db.run("DELETE FROM job_scores WHERE hunt_id = ? AND stage = 'filtered'", [hunt.id])
    ctx.queue.enqueue('match.score', {}, { dedupeKey: 'match.score' })
    ctx.worker.kick()
    ctx.bus.changed('hunts', 'jobs')
    return hunt
  })
  router.on('hunts.delete', ({ id }) => {
    db.run('DELETE FROM hunts WHERE id = ?', [id])
    ctx.bus.changed('hunts', 'jobs')
    return null
  })

  router.on('hunts.preview', ({ config }): HuntPreview => {
    const { profile } = loadProfile(db)
    const rows = db.all<Candidate>(
      `SELECT j.id, j.group_id, j.source_kind, j.title, j.title_norm, j.company_name, j.company_id, co.blocked, j.seniority, j.employment_type,
              j.contract_type, j.remote, j.locations, j.location_text, j.salary, j.salary_annual_min, j.salary_annual_max, j.posted_at, j.first_seen_at, j.signals, j.meta
       FROM jobs j LEFT JOIN companies co ON co.id = j.company_id
       WHERE j.closed_at IS NULL AND COALESCE(j.posted_at, j.first_seen_at) >= ? AND j.id = COALESCE(j.group_id, j.id)`,
      [ctx.now() - (config.postedWithinDays + 2) * 86_400_000],
    )
    const counts = new Map<string, number>()
    let pass = 0
    for (const r of rows) {
      const f = applyFilters(toFilterJob(ctx, r, config.companyCooldown.days), config, profile, ctx.now())
      if (f.passed) pass++
      else {
        const label = FILTER_LABELS[f.codes[0]!]
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
    }
    return { total: rows.length, pass, reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) }
  })

  router.on('hunts.runNow', () => {
    db.run("UPDATE sources SET next_poll_at = 0 WHERE enabled = 1 AND (origin IN ('user', 'import', 'builtin') OR priority > 0)")
    ctx.queue.enqueue('match.score', {}, { dedupeKey: 'match.score' })
    ctx.worker.kick()
    ctx.bus.changed('sources')
    return null
  })

  router.on('hunts.suggestTitles', async ({ titles }) => (await s.ai.structured(titleIdeasPrompt, { titles }, { task: 'Suggest titles' })).titles)
  router.on('hunts.suggestions', ({ id }) => huntSuggestions(db, id, ctx.now()))

}
