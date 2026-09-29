import { json } from '../core/db'
import { errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { credentials } from '../integrations'
import { type IngestResult, ingest } from '../jobs/ingest'
import { huntQueries, targetedCompanyKeys } from '../match/hunts'
import { companyKey } from '../jobs/classify'
import { MIN_INTERVAL_HOURS, adapterFor } from './index'
import type { SourceKind } from './types'

type SourceRow = {
  id: number
  kind: string
  key: string
  label: string
  company_id: number | null
  config: string
  origin: string
  priority: number
  consecutive_errors: number
  enabled: number
}

const jitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2))

/** How long until a source should be polled again. Targeted companies are checked more often. */
export function nextInterval(ctx: Ctx, s: SourceRow, targeted: boolean): number {
  const d = ctx.settings.get().discovery
  const minHours = MIN_INTERVAL_HOURS[s.kind as SourceKind]
  if (minHours) return jitter(minHours * 3600_000)
  if (targeted || s.origin === 'user' || s.priority > 0) return jitter(d.targetedIntervalMinutes * 60_000)
  return jitter(d.registryIntervalHours * 3600_000)
}

function isTargeted(ctx: Ctx, s: SourceRow, keys: Set<string>): boolean {
  if (keys.size && s.company_id) {
    const name = ctx.db.get<{ name: string }>('SELECT name FROM companies WHERE id = ?', [s.company_id])?.name
    if (name && keys.has(companyKey(name))) return true
  }
  // Companies that produced a match recently.
  return !!ctx.db.get(
    `SELECT 1 FROM job_scores js JOIN jobs j ON j.id = js.job_id
     WHERE j.source_id = ? AND js.passed = 1 AND js.score >= 65 AND js.created_at > ? LIMIT 1`,
    [s.id, ctx.now() - 30 * 86_400_000],
  )
}

/** Enqueues due sources. Called every minute. Registry sources are skipped when the registry is turned off. */
export function scheduleDuePolls(ctx: Ctx, limit = 25): number {
  const d = ctx.settings.get().discovery
  const rows = ctx.db.all<{ id: number }>(
    `SELECT id FROM sources WHERE enabled = 1 AND next_poll_at <= ? ${d.registryEnabled ? '' : "AND origin != 'registry'"}
     ORDER BY priority DESC, next_poll_at ASC LIMIT ?`,
    [ctx.now(), limit],
  )
  for (const r of rows) ctx.queue.enqueue('sources.poll', { id: r.id }, { dedupeKey: `poll:${r.id}`, priority: 1 })
  return rows.length
}

/** Task handler: fetch one source, store results, schedule scoring. Errors are recorded on the source, not retried by the queue. */
export async function pollSource(ctx: Ctx, id: number, signal?: AbortSignal): Promise<IngestResult | null> {
  const s = ctx.db.get<SourceRow>('SELECT * FROM sources WHERE id = ?', [id])
  if (!s || !s.enabled) return null
  const started = ctx.now()
  const targeted = isTargeted(ctx, s, targetedCompanyKeys(ctx.db))
  try {
    const adapter = adapterFor(s.kind)
    const result = await adapter.fetch(json.parse(s.config, {}), { http: ctx.http, now: started, signal, queries: huntQueries(ctx.db), credentials: credentials(ctx) })
    const res = ingest(ctx.db, { id: s.id, kind: s.kind }, result, started)
    const label = result.companyName && s.origin !== 'builtin' ? result.companyName : s.label
    ctx.db.run('UPDATE sources SET last_polled_at = ?, last_ok_at = ?, consecutive_errors = 0, last_error = NULL, next_poll_at = ?, label = ? WHERE id = ?', [
      started,
      started,
      started + nextInterval(ctx, s, targeted),
      label,
      s.id,
    ])
    if (res.inserted.length || res.updated.length) {
      ctx.queue.enqueue('match.score', {}, { dedupeKey: 'match.score', runAt: ctx.now() + 5_000 })
      ctx.bus.changed('jobs')
    }
    ctx.bus.changed('sources')
    return res
  } catch (err) {
    const errors = s.consecutive_errors + 1
    const backoff = Math.min(24 * 3600_000, nextInterval(ctx, s, targeted) * 2 ** Math.min(errors, 5))
    ctx.db.run('UPDATE sources SET last_polled_at = ?, consecutive_errors = ?, last_error = ?, next_poll_at = ? WHERE id = ?', [started, errors, errorMessage(err), started + backoff, s.id])
    ctx.log.warn('source poll failed', { source: `${s.kind}:${s.key}`, errors, err: errorMessage(err) })
    ctx.bus.changed('sources')
    return null
  }
}
