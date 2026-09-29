import { backupDatabase } from '../app/handlers'
import type { Ctx } from '../engine'
import { credentials } from '../integrations'
import type { Notifier } from '../notify'
import { scheduleMailSync } from '../mail/handlers'
import { expireClosed } from '../packages/store'
import { setStatus } from '../tracker/applications'
import { scheduleDuePolls } from '../sources/poller'
import { ensureAggregators } from '../sources/registry'

type Tick = { name: string; everyMs: number; run: () => void | Promise<void> }

/**
 * Wall-clock schedules. Each is materialized into tasks or runs inline; after sleep, a missed schedule
 * runs once, not once per missed interval.
 */
export class Schedules {
  private readonly ticks: (Tick & { lastRun: number })[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly ctx: Ctx) {}

  add(name: string, everyMs: number, run: Tick['run']): this {
    this.ticks.push({ name, everyMs, run, lastRun: 0 })
    return this
  }

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  async tick(): Promise<void> {
    const now = this.ctx.now()
    for (const t of this.ticks) {
      if (now - t.lastRun < t.everyMs) continue
      t.lastRun = now
      try {
        await t.run()
      } catch (err) {
        this.ctx.log.error(`schedule ${t.name} failed`, { err })
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export function coreSchedules(ctx: Ctx, notifier: Notifier): Schedules {
  const s = new Schedules(ctx)
  // The sample workspace never reaches real job sites.
  if (!ctx.demo) {
    s.add('polls', 60_000, () => {
      if (!ctx.settings.get().paused) scheduleDuePolls(ctx)
    })
    s.add('aggregators', 10 * 60_000, () => ensureAggregators(ctx, credentials(ctx)))
  }
  s.add('digest', 5 * 60_000, () => notifier.flushMatches())
  s.add('mail', 5 * 60_000, () => {
    if (!ctx.settings.get().paused && !ctx.demo) scheduleMailSync(ctx)
  })
  s.add('outreach', 60_000, () => {
    if (!ctx.settings.get().paused && ctx.db.get("SELECT 1 FROM outreach WHERE status = 'scheduled' AND scheduled_at <= ?", [ctx.now()])) ctx.queue.enqueue('outreach.send', {}, { dedupeKey: 'outreach.send' })
  })
  s.add('expire', 3600_000, () => {
    if (expireClosed(ctx)) ctx.bus.changed('packages')
  })
  s.add('maintenance', 6 * 3600_000, async () => {
    const last = ctx.db.get<{ t: number | null }>("SELECT MAX(finished_at) t FROM tasks WHERE type = 'maintenance.daily' AND status = 'done'")?.t ?? 0
    if (ctx.now() - last > 20 * 3600_000) ctx.queue.enqueue('maintenance.daily', {}, { dedupeKey: 'maintenance.daily' })
  })
  return s
}

/** Daily: backup, prune old tasks and cache, mark silent applications ghosted. */
export async function dailyMaintenance(ctx: Ctx): Promise<void> {
  await backupDatabase(ctx)
  ctx.queue.prune()
  ctx.db.run('DELETE FROM ai_cache WHERE created_at < ?', [ctx.now() - 30 * 86_400_000])
  ctx.db.run('DELETE FROM notifications WHERE created_at < ?', [ctx.now() - 90 * 86_400_000])
  const days = ctx.settings.get().tracker.ghostAfterDays
  const ghosted = ctx.db.all<{ id: number }>(
    `SELECT id FROM applications WHERE archived = 0 AND status IN ('applied', 'applied_unverified') AND last_activity_at < ?`,
    [ctx.now() - days * 86_400_000],
  )
  for (const a of ghosted) setStatus(ctx.db, a.id, 'ghosted', 'rule', { note: `No reply for ${days} days.` }, ctx.now())
  if (ghosted.length) ctx.bus.changed('applications')
}
