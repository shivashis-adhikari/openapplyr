import { type Hunt, type HuntConfig, HuntConfigSchema, type HuntMode } from '../../shared/domain'
import { type Db, json } from '../core/db'
import { AppError } from '../core/errors'
import type { SearchQuery } from '../sources/types'
import { companyKey } from '../jobs/classify'

type HuntRow = { id: number; name: string; mode: HuntMode; config: string; base_resume_id: number | null; active: number; created_at: number; last_run_at: number | null }

const toHunt = (r: HuntRow): Hunt => {
  const parsed = HuntConfigSchema.safeParse(json.parse(r.config, {}))
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    active: !!r.active,
    baseResumeId: r.base_resume_id,
    config: parsed.success ? parsed.data : HuntConfigSchema.parse({}),
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  }
}

export function listHunts(db: Db, activeOnly = false): Hunt[] {
  return db.all<HuntRow>(`SELECT * FROM hunts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at`).map(toHunt)
}

export function getHunt(db: Db, id: number): Hunt {
  const r = db.get<HuntRow>('SELECT * FROM hunts WHERE id = ?', [id])
  if (!r) throw new AppError('NOT_FOUND', 'That hunt no longer exists.', { permanent: true })
  return toHunt(r)
}

export function saveHunt(db: Db, h: { id?: number | undefined; name: string; mode: HuntMode; active: boolean; baseResumeId: number | null; config: HuntConfig }, now: number): Hunt {
  const config = HuntConfigSchema.parse(h.config)
  if (config.titles.length === 0) throw new AppError('NO_TITLES', 'Add at least one job title to search for.', { permanent: true })
  if (config.autopilotThreshold < config.queueThreshold) throw new AppError('THRESHOLDS', 'The autopilot threshold must be at or above the queue threshold.', { permanent: true })
  if (h.id) {
    db.run('UPDATE hunts SET name = ?, mode = ?, active = ?, base_resume_id = ?, config = ?, updated_at = ? WHERE id = ?', [h.name, h.mode, h.active, h.baseResumeId, JSON.stringify(config), now, h.id])
    return getHunt(db, h.id)
  }
  const id = db.run('INSERT INTO hunts (name, mode, active, base_resume_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    h.name,
    h.mode,
    h.active,
    h.baseResumeId,
    JSON.stringify(config),
    now,
    now,
  ]).lastInsertRowid
  return getHunt(db, id)
}

/** Search queries for keyword-driven sources, derived from active hunts. */
export function huntQueries(db: Db, max = 8): SearchQuery[] {
  const out: SearchQuery[] = []
  for (const h of listHunts(db, true)) {
    const c = h.config
    const places = c.places.length ? c.places.slice(0, 2) : [null]
    for (const title of c.titles.slice(0, 3)) {
      for (const p of places) {
        out.push({ keywords: title, location: p ? (p.city ?? p.label) : null, country: p?.country ?? c.remoteCountries[0] ?? null, remote: c.workplace.remote })
      }
    }
  }
  return out.slice(0, max)
}

/** Company keys a hunt explicitly targets, polled more often. */
export function targetedCompanyKeys(db: Db): Set<string> {
  const keys = new Set<string>()
  for (const h of listHunts(db, true)) for (const c of h.config.companiesInclude) keys.add(companyKey(c))
  return keys
}

/** Hunt settings for a package; a job prepared by hand outside any hunt uses the defaults in review mode. */
export function huntFor(db: Db, huntId: number | null): { id: number | null; mode: HuntMode; config: HuntConfig; baseResumeId: number | null } {
  if (huntId === null) return { id: null, mode: 'review', config: HuntConfigSchema.parse({}), baseResumeId: null }
  const h = getHunt(db, huntId)
  return { id: h.id, mode: h.mode, config: h.config, baseResumeId: h.baseResumeId }
}
