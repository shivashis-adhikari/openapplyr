import type { HuntConfig } from '../../shared/domain'
import { startOfDay } from '../ai/ledger'
import type { Ctx } from '../engine'

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** Next moment inside the active hours (local time), or `now` when already inside. */
export function nextActiveTime(now: number, hours: { start: string; end: string }): number {
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = minutes(hours.start)
  const end = minutes(hours.end)
  const inside = start <= end ? cur >= start && cur < end : cur >= start || cur < end
  if (inside) return now
  const at = new Date(now)
  at.setHours(Math.floor(start / 60), start % 60, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

export type Slot = { at: number; reason: string } | null

/**
 * When an approved application may run. Null means now.
 * Runs the user starts themselves skip hours and caps but still respect the gap per site.
 */
export function nextSlot(
  ctx: Ctx,
  a: { id: number; huntId: number | null; companyId: number | null; host: string },
  config: Pick<HuntConfig, 'activeHours' | 'dailyApplyCap' | 'companyCooldown'>,
  manual: boolean,
  random = Math.random,
): Slot {
  const now = ctx.now()
  const auto = ctx.settings.get().automation
  const { db } = ctx
  const lastOnHost = db.get<{ t: number | null }>(
    'SELECT MAX(r.started_at) t FROM runs r JOIN applications a ON a.id = r.application_id WHERE a.url LIKE ? OR a.url LIKE ?',
    [`%://${a.host}/%`, `%://${a.host}:%`],
  )?.t
  if (lastOnHost && now - lastOnHost < auto.perHostGapSeconds * 1000) return { at: lastOnHost + auto.perHostGapSeconds * 1000, reason: `Waiting ${auto.perHostGapSeconds} seconds between applications on ${a.host}.` }
  if (manual) return null

  const active = nextActiveTime(now, config.activeHours)
  if (active > now) return { at: active, reason: `Outside this hunt's active hours (${config.activeHours.start} to ${config.activeHours.end}).` }

  const today = startOfDay(now)
  const tomorrow = nextActiveTime(today + 86_400_000 + 1, config.activeHours)
  const appliedToday = (huntOnly: boolean) =>
    db.get<{ n: number }>(`SELECT COUNT(*) n FROM applications WHERE applied_at >= ? ${huntOnly ? 'AND hunt_id = ?' : ''}`, huntOnly ? [today, a.huntId] : [today])!.n
  if (appliedToday(false) >= auto.globalDailyApplyCap) return { at: tomorrow, reason: `Reached the daily limit of ${auto.globalDailyApplyCap} applications.` }
  if (a.huntId !== null && appliedToday(true) >= config.dailyApplyCap) return { at: tomorrow, reason: `Reached this hunt's daily limit of ${config.dailyApplyCap}.` }

  if (a.companyId !== null) {
    const since = now - config.companyCooldown.days * 86_400_000
    const recent = db.all<{ applied_at: number }>('SELECT applied_at FROM applications WHERE company_id = ? AND applied_at >= ? AND id != ? ORDER BY applied_at', [a.companyId, since, a.id])
    if (recent.length >= config.companyCooldown.max) {
      return { at: recent[0]!.applied_at + config.companyCooldown.days * 86_400_000, reason: `Already applied to this company ${recent.length} times in ${config.companyCooldown.days} days.` }
    }
  }

  const lastEnd = db.get<{ t: number | null }>("SELECT MAX(ended_at) t FROM runs WHERE status IN ('submitted', 'failed', 'dry_run_done')")?.t
  if (lastEnd) {
    const gap = (auto.minGapSeconds + random() * Math.max(0, auto.maxGapSeconds - auto.minGapSeconds)) * 1000
    if (now < lastEnd + gap) return { at: Math.round(lastEnd + gap), reason: 'Spacing applications out.' }
  }
  return null
}
