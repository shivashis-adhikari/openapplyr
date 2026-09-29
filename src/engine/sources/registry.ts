import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { upsertCompany } from '../jobs/ingest'
import { AGGREGATOR_KINDS, ATS_KINDS, type AggregatorKind, type AtsKind } from './types'
import { boardKey, detectAts } from './detect'
import { ADAPTERS } from './index'

const EntrySchema = z.object({
  ats: z.enum(ATS_KINDS),
  board: z.record(z.string(), z.string()),
  name: z.string().optional(),
  domain: z.string().optional(),
})
export type RegistryEntry = z.infer<typeof EntrySchema>

/** Reads a JSON-lines registry (optionally gzipped). Invalid lines are skipped, never fatal. */
export function readRegistry(path: string): RegistryEntry[] {
  if (!existsSync(path)) return []
  let buf = readFileSync(path)
  if (path.endsWith('.gz')) buf = gunzipSync(buf)
  const out: RegistryEntry[] = []
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = EntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) out.push(parsed.data)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

export function addBoard(ctx: Ctx, ats: AtsKind, board: Record<string, string>, o: { origin: 'registry' | 'user' | 'import'; name?: string | undefined; domain?: string | undefined; priority?: number }): number {
  const key = boardKey(ats, board)
  const existing = ctx.db.get<{ id: number; origin: string }>('SELECT id, origin FROM sources WHERE kind = ? AND key = ?', [ats, key])
  if (existing) {
    if (o.origin === 'user' && existing.origin !== 'user') {
      ctx.db.run("UPDATE sources SET origin = 'user', priority = MAX(priority, ?), enabled = 1, next_poll_at = 0 WHERE id = ?", [o.priority ?? 1, existing.id])
    }
    return existing.id
  }
  const companyId = o.name ? upsertCompany(ctx.db, o.name, { domain: o.domain ?? null, ats, now: ctx.now() }) : null
  const config = { ...board, ...(o.name ? { name: o.name } : {}) }
  return ctx.db.run(
    'INSERT INTO sources (kind, key, label, company_id, config, origin, priority, next_poll_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ats, key, o.name ?? key, companyId, JSON.stringify(config), o.origin, o.priority ?? (o.origin === 'registry' ? 0 : 1), o.origin === 'registry' ? ctx.now() + Math.floor(Math.random() * 3600_000) : 0, ctx.now()],
  ).lastInsertRowid
}

/** Loads the bundled registry and any downloaded update into the sources table. */
export function syncRegistry(ctx: Ctx): number {
  const files = [join(ctx.paths.resources, 'registry', 'companies.jsonl'), join(ctx.paths.data, 'registry-update.jsonl.gz')]
  const count = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM sources')!.n
  const before = count()
  ctx.db.tx(() => {
    for (const f of files) for (const e of readRegistry(f)) addBoard(ctx, e.ats, e.board, { origin: 'registry', name: e.name, domain: e.domain })
  })
  return count() - before
}

const FREE_AGGREGATORS: AggregatorKind[] = ['remotive', 'remoteok', 'arbeitnow', 'themuse', 'himalayas', 'hn']
const KEYED: Record<string, string> = { adzuna: 'adzunaAppKey', usajobs: 'usajobsKey', jooble: 'joobleKey', reed: 'reedKey' }

/** One source row per aggregator; enabled per settings, keyed ones only when their key is connected. */
export function ensureAggregators(ctx: Ctx, creds: Record<string, string>): void {
  const prefs = ctx.settings.get().discovery.aggregators
  for (const kind of AGGREGATOR_KINDS) {
    const keyField = KEYED[kind]
    const defaultOn = FREE_AGGREGATORS.includes(kind) || (!!keyField && !!creds[keyField])
    const enabled = keyField && !creds[keyField] ? false : (prefs[kind] ?? defaultOn)
    const row = ctx.db.get<{ id: number; enabled: number }>("SELECT id, enabled FROM sources WHERE kind = ? AND key = 'default'", [kind])
    if (!row) {
      ctx.db.run("INSERT INTO sources (kind, key, label, config, origin, enabled, next_poll_at, created_at) VALUES (?, 'default', ?, '{}', 'builtin', ?, 0, ?)", [
        kind,
        ADAPTERS[kind]?.label ?? kind,
        enabled,
        ctx.now(),
      ])
    } else if (!!row.enabled !== enabled) {
      ctx.db.run('UPDATE sources SET enabled = ?, next_poll_at = 0 WHERE id = ?', [enabled, row.id])
    }
  }
}

/** "Watch company": adds a board from a careers or job URL and polls it right away. */
export function watchUrl(ctx: Ctx, url: string): { sourceId: number; ats: string; key: string } {
  const d = detectAts(url)
  if (!d) throw new AppError('UNKNOWN_SITE', 'OpenApplyr does not recognize that careers site yet. Paste a Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Recruitee or Workable link.', { permanent: true })
  if (!d.board || !(ATS_KINDS as readonly string[]).includes(d.ats)) {
    throw new AppError('NOT_POLLABLE', `${d.ats} boards cannot be watched automatically. Import single jobs from it with a link instead.`, { permanent: true })
  }
  const sourceId = addBoard(ctx, d.ats as AtsKind, d.board, { origin: 'user', priority: 2 })
  return { sourceId, ats: d.ats, key: boardKey(d.ats, d.board) }
}
