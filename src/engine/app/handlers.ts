import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import type { ActivityTask, EngineStatus, LedgerRow, SourceHealth, TodayItem, TodaySummary } from '../../shared/api/core'
import { json } from '../core/db'
import type { SettingsPatch } from '../../shared/settings'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { spendSince, startOfDay, startOfMonth } from '../ai/ledger'
import { loadProfile } from '../profile/store'
import { exportApplications } from '../tracker/csv'

const TASK_LABELS: Record<string, string> = {
  'sources.poll': 'Check job source',
  'match.score': 'Score new jobs',
  'packages.prepare': 'Prepare application',
  'apply.run': 'Apply',
  'mail.sync': 'Check email',
  'outreach.send': 'Send email',
  'contacts.discover': 'Find contacts',
  'registry.refresh': 'Update company list',
  'maintenance.daily': 'Daily maintenance',
}

export function needsYouCount(ctx: Ctx): number {
  const n = (sql: string) => ctx.db.get<{ n: number }>(sql)!.n
  return (
    n("SELECT COUNT(*) n FROM applications WHERE status IN ('needs_user', 'applied_unverified') AND archived = 0") +
    n("SELECT COUNT(*) n FROM packages WHERE status IN ('ready', 'failed')") +
    n('SELECT COUNT(*) n FROM mail_messages WHERE needs_review = 1 AND handled = 0') +
    n("SELECT COUNT(DISTINCT thread_key) n FROM outreach WHERE status = 'draft'")
  )
}

/**
 * The worklist behind the Today screen: everything waiting on the user, most urgent first, then
 * what happened today. Every item names the job or person and the exact blocker.
 */
export function todaySummary(ctx: Ctx): TodaySummary {
  const { db } = ctx
  const now = ctx.now()
  const day = startOfDay(now)
  const items: TodayItem[] = []
  for (const r of db.all<{ id: number; company_name: string; title: string; question: string | null; status: string; run_id: number | null; run_status: string | null; last_activity_at: number; field_name: string | null }>(
    `SELECT a.id, a.company_name, a.title, r.question, a.status, r.id run_id, r.status run_status, a.last_activity_at,
       (SELECT json_extract(e.data, '$.fieldName') FROM events e WHERE e.application_id = a.id AND e.type = 'needs_user' ORDER BY e.id DESC LIMIT 1) field_name
     FROM applications a
     LEFT JOIN runs r ON r.id = (SELECT MAX(id) FROM runs WHERE application_id = a.id)
     WHERE a.archived = 0 AND a.status IN ('needs_user', 'applied_unverified', 'failed') ORDER BY a.last_activity_at DESC LIMIT 50`,
  )) {
    const kind: TodayItem['kind'] = r.status === 'applied_unverified' ? 'unverified' : r.status === 'failed' ? 'failed' : r.run_status === 'dry_run_done' ? 'dry_run' : 'question'
    if (kind === 'failed' && r.run_status === 'stopped') continue
    items.push({ kind, id: r.id, runId: r.run_id, fieldName: r.field_name, title: `${r.company_name}: ${r.title}`, detail: r.question ?? '', at: r.last_activity_at })
  }
  for (const p of db.all<{ id: number; title: string; company_name: string; answers: string; status: string; error: string | null; created_at: number }>(
    "SELECT p.id, j.title, j.company_name, p.answers, p.status, p.error, p.created_at FROM packages p JOIN jobs j ON j.id = p.job_id WHERE p.status IN ('ready', 'failed') ORDER BY p.created_at LIMIT 200",
  )) {
    const missing = json.parse<{ needsUser: boolean }[]>(p.answers, []).filter((a) => a.needsUser).length
    items.push({ kind: p.status === 'failed' ? 'package_failed' : missing ? 'package_answers' : 'package', id: p.id, runId: null, fieldName: null, title: `${p.company_name}: ${p.title}`, detail: p.status === 'failed' ? (p.error ?? '') : String(missing), at: p.created_at })
  }
  for (const m of db.all<{ id: number; subject: string | null; from_name: string | null; from_addr: string; date: number }>('SELECT id, subject, from_name, from_addr, date FROM mail_messages WHERE needs_review = 1 AND handled = 0 ORDER BY date DESC LIMIT 50')) {
    items.push({ kind: 'mail', id: m.id, runId: null, fieldName: null, title: m.from_name || m.from_addr, detail: m.subject ?? '', at: m.date })
  }
  for (const o of db.all<{ id: number; name: string; company_name: string | null; created_at: number }>(
    "SELECT o.id, c.name, COALESCE(a.company_name, c.company_name) company_name, o.created_at FROM outreach o JOIN contacts c ON c.id = o.contact_id LEFT JOIN applications a ON a.id = o.application_id WHERE o.status = 'draft' AND o.step = 0 ORDER BY o.created_at LIMIT 50",
  )) {
    items.push({ kind: 'outbox', id: o.id, runId: null, fieldName: null, title: o.company_name ? `${o.name}, ${o.company_name}` : o.name, detail: '', at: o.created_at })
  }
  for (const a of db.all<{ id: number; address: string; status_detail: string | null }>("SELECT id, address, status_detail FROM mail_accounts WHERE status = 'auth_error'")) {
    items.push({ kind: 'mail_auth', id: a.id, runId: null, fieldName: null, title: a.address, detail: a.status_detail ?? '', at: now })
  }
  const order: TodayItem['kind'][] = ['question', 'mail_auth', 'package_answers', 'dry_run', 'failed', 'package_failed', 'mail', 'unverified', 'outbox', 'package']
  items.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || y.at - x.at)

  const count = (sql: string, args: (number | string)[] = []) => db.get<{ n: number }>(sql, args)!.n
  return {
    items,
    counts: {
      needsYou: needsYouCount(ctx),
      appliedToday: count('SELECT COUNT(*) n FROM applications WHERE applied_at >= ?', [day]),
      repliesToday: count("SELECT COUNT(*) n FROM mail_messages WHERE direction = 'in' AND application_id IS NOT NULL AND date >= ?", [day]),
      matchesToday: count("SELECT COUNT(*) n FROM job_scores s JOIN hunts h ON h.id = s.hunt_id WHERE s.stage = 'judged' AND s.score >= json_extract(h.config, '$.queueThreshold') AND s.created_at >= ?", [day]),
      sentToday: count("SELECT COUNT(*) n FROM outreach WHERE status = 'sent' AND sent_at >= ?", [day]),
      applying: count("SELECT COUNT(*) n FROM applications WHERE status IN ('queued', 'applying') AND archived = 0"),
    },
    setup: {
      model: !!db.get('SELECT 1 FROM model_roles LIMIT 1'),
      profile: !!db.get("SELECT 1 FROM profile WHERE json_array_length(json_extract(data, '$.work')) > 0"),
      hunt: !!db.get('SELECT 1 FROM hunts WHERE active = 1'),
      mail: !!db.get('SELECT 1 FROM mail_accounts'),
    },
    interviews: db
      .all<{ id: number; application_id: number | null; starts_at: number; kind: string; company_name: string | null; title: string | null; link: string | null }>(
        'SELECT i.id, i.application_id, i.starts_at, i.kind, a.company_name, a.title, i.link FROM interviews i LEFT JOIN applications a ON a.id = i.application_id WHERE i.starts_at BETWEEN ? AND ? ORDER BY i.starts_at',
        [now - 3600_000, now + 7 * 86_400_000],
      )
      .map((i) => ({ id: i.id, applicationId: i.application_id, startsAt: i.starts_at, kind: i.kind, company: i.company_name ?? '', title: i.title ?? '', link: i.link })),
  }
}

export function engineStatus(ctx: Ctx): EngineStatus {
  const s = ctx.settings.get()
  const now = ctx.now()
  const today = spendSince(ctx.db, startOfDay(now))
  const month = spendSince(ctx.db, startOfMonth(now))
  const next = ctx.db.get<{ t: number | null }>('SELECT MIN(next_poll_at) t FROM sources WHERE enabled = 1')?.t ?? null
  return {
    version: ctx.appVersion,
    demo: ctx.demo,
    paused: s.paused,
    onboarded: s.onboarded,
    activeTasks: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE status = 'running'")!.n,
    activeRuns: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE status IN ('running', 'needs_user')")!.n,
    needsYou: needsYouCount(ctx),
    spendToday: today.cost,
    spendMonth: month.cost,
    budgetDaily: s.budget.daily,
    budgetMonthly: s.budget.monthly,
    unpricedCallsToday: today.unpriced,
    nextScanAt: next,
    dataDir: ctx.paths.data,
  }
}

/** Copies the live database safely (online backup), keeping the newest `keep` copies. */
export async function backupDatabase(ctx: Ctx, keep = 7): Promise<string> {
  mkdirSync(ctx.paths.backups, { recursive: true })
  const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')
  const file = join(ctx.paths.backups, `openapplyr-${stamp}.db`)
  await backup(ctx.db.raw, file)
  const files = readdirSync(ctx.paths.backups)
    .filter((f) => f.startsWith('openapplyr-') && f.endsWith('.db'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(ctx.paths.backups, f), { force: true })
  return file
}

export function registerAppHandlers(ctx: Ctx, onDeleteAll: () => Promise<void>): void {
  const { router, db } = ctx
  router.on('today.summary', () => todaySummary(ctx))

  router.on('app.status', () => engineStatus(ctx))
  router.on('app.pause', ({ paused }) => {
    ctx.settings.update({ paused })
    ctx.worker.setPaused(paused)
    ctx.bus.changed('engine')
    return engineStatus(ctx)
  })

  router.on('settings.get', () => ctx.settings.get())
  router.on('settings.update', (patch) => ctx.settings.update(patch as SettingsPatch))

  router.on('activity.tasks', ({ status, limit }) => {
    const where = status === 'all' ? '' : 'WHERE status = ?'
    const rows = db.all<{ id: number; type: string; status: string; attempts: number; run_at: number; last_error: string | null; finished_at: number | null }>(
      `SELECT id, type, status, attempts, run_at, last_error, finished_at FROM tasks ${where} ORDER BY COALESCE(finished_at, run_at) DESC LIMIT ?`,
      status === 'all' ? [limit] : [status, limit],
    )
    return rows.map(
      (r): ActivityTask => ({
        id: r.id,
        type: r.type,
        status: r.status,
        attempts: r.attempts,
        runAt: r.run_at,
        lastError: r.last_error,
        finishedAt: r.finished_at,
        label: TASK_LABELS[r.type] ?? r.type,
      }),
    )
  })

  router.on('activity.retryTask', ({ id }) => {
    const r = db.run("UPDATE tasks SET status = 'pending', run_at = ?, attempts = 0, last_error = NULL WHERE id = ? AND status = 'failed'", [ctx.now(), id])
    if (r.changes === 0) throw new AppError('NOT_FOUND', 'That task is not in a failed state.', { permanent: true })
    ctx.worker.kick()
    ctx.bus.changed('tasks')
    return null
  })

  router.on('activity.sources', ({ onlyProblems, limit }) => {
    const rows = db.all<{
      id: number
      kind: string
      label: string
      enabled: number
      job_count: number
      last_polled_at: number | null
      last_ok_at: number | null
      consecutive_errors: number
      last_error: string | null
      next_poll_at: number
    }>(
      `SELECT id, kind, label, enabled, job_count, last_polled_at, last_ok_at, consecutive_errors, last_error, next_poll_at
       FROM sources ${onlyProblems ? 'WHERE consecutive_errors > 0' : ''}
       ORDER BY consecutive_errors DESC, last_polled_at DESC LIMIT ?`,
      [limit],
    )
    return rows.map(
      (r): SourceHealth => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        enabled: !!r.enabled,
        jobCount: r.job_count,
        lastPolledAt: r.last_polled_at,
        lastOkAt: r.last_ok_at,
        consecutiveErrors: r.consecutive_errors,
        lastError: r.last_error,
        nextPollAt: r.next_poll_at,
      }),
    )
  })

  router.on('activity.ledger', ({ limit }) =>
    db
      .all<{
        id: number
        at: number
        provider_kind: string | null
        model_id: string | null
        role: string | null
        task: string | null
        input_tokens: number | null
        output_tokens: number | null
        cost: number | null
        ok: number
        error: string | null
      }>('SELECT * FROM ai_ledger ORDER BY at DESC LIMIT ?', [limit])
      .map(
        (r): LedgerRow => ({
          id: r.id,
          at: r.at,
          provider: r.provider_kind ?? '',
          model: r.model_id ?? '',
          role: r.role ?? '',
          task: r.task ?? '',
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cost: r.cost,
          ok: !!r.ok,
          error: r.error,
        }),
      ),
  )

  router.on('data.backupNow', async () => ({ path: await backupDatabase(ctx) }))

  router.on('data.export', async ({ path }) => {
    if (existsSync(path)) throw new AppError('EXISTS', 'Choose a new folder name; that one already exists.', { permanent: true })
    mkdirSync(path, { recursive: true })
    const dbCopy = join(path, 'openapplyr.db')
    await backup(ctx.db.raw, dbCopy)
    // The copy leaves out every key and password, even encrypted ones.
    const copy = new DatabaseSync(dbCopy)
    try {
      copy.exec("DELETE FROM ats_accounts; DELETE FROM secrets; UPDATE mail_accounts SET secret_id = NULL, cursor = '{}'; UPDATE providers SET secret_id = NULL; UPDATE integrations SET secret_id = NULL; VACUUM;")
    } finally {
      copy.close()
    }
    writeFileSync(join(path, 'profile.json'), JSON.stringify(loadProfile(db).profile, null, 2))
    writeFileSync(join(path, 'applications.csv'), exportApplications(db, 'csv'))
    writeFileSync(join(path, 'applications.json'), exportApplications(db, 'json'))
    for (const dir of ['documents', 'evidence'] as const) {
      if (existsSync(ctx.paths[dir])) cpSync(ctx.paths[dir], join(path, dir), { recursive: true })
    }
    return { path }
  })

  router.on('data.deleteAll', async () => {
    await onDeleteAll()
    return null
  })

  router.on('data.revealDataDir', async () => {
    await ctx.host.request('reveal', { path: ctx.paths.db })
    return null
  })
}
