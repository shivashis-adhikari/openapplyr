import type { AppStatus } from '../../shared/domain'
import type { Db } from '../core/db'
import { json } from '../core/db'
import { titleKey } from '../jobs/classify'

export type GroupRate = { key: string; applied: number; responded: number; rate: number }
export type WeekRow = { week: number; applied: number; responses: number; spend: number }
export type Analytics = {
  since: number | null
  applied: number
  responded: number
  screen: number
  interview: number
  offer: number
  rejected: number
  ghosted: number
  medianDaysToResponse: number | null
  byChannel: GroupRate[]
  byTemplate: GroupRate[]
  byHunt: GroupRate[]
  byTitle: GroupRate[]
  byDaysAfterPosting: GroupRate[]
  weekly: WeekRow[]
  spend: { total: number; perApplication: number | null }
  notes: string[]
}

const DAY = 86_400_000
const STAGE: Partial<Record<AppStatus, number>> = { screening: 1, interviewing: 2, offer: 3, accepted: 3, declined: 3 }
/** A reply from the company counts as a response whatever it says. */
const RESPONSE_STATUSES = new Set(['screening', 'interviewing', 'offer', 'accepted', 'declined', 'rejected'])
const RESPONSE_MAIL = new Set(['rejection', 'interview_request', 'assessment', 'offer', 'positive_reply', 'negative_reply', 'neutral_reply', 'scheduling'])
/** The minimum group size before a comparison is shown. */
export const MIN_GROUP = 20

const monday = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

function rates(rows: { key: string; responded: boolean }[]): GroupRate[] {
  const m = new Map<string, GroupRate>()
  for (const r of rows) {
    const g = m.get(r.key) ?? { key: r.key, applied: 0, responded: 0, rate: 0 }
    g.applied++
    if (r.responded) g.responded++
    m.set(r.key, g)
  }
  return [...m.values()].map((g) => ({ ...g, rate: g.applied ? g.responded / g.applied : 0 })).sort((a, b) => b.applied - a.applied)
}

const pct = (g: GroupRate) => `${Math.round(g.rate * 100)}% (${g.responded} of ${g.applied})`

/** Computed from the event log only, so imported and hand-added applications count the same way. */
export function analytics(db: Db, since: number | null, now: number): Analytics {
  const apps = db.all<{
    id: number
    status: AppStatus
    method: string | null
    channel: string
    applied_at: number
    hunt: string | null
    title: string
    template_id: string | null
    posted_at: number | null
  }>(
    `SELECT a.id, a.status, a.method, a.channel, a.applied_at, h.name hunt, a.title, r.template_id, j.posted_at
     FROM applications a
     LEFT JOIN hunts h ON h.id = a.hunt_id
     LEFT JOIN packages p ON p.id = a.package_id
     LEFT JOIN resumes r ON r.id = p.resume_id
     LEFT JOIN jobs j ON j.id = a.job_id
     WHERE a.applied_at IS NOT NULL ${since ? 'AND a.applied_at >= ?' : ''}`,
    since ? [since] : [],
  )
  const events = db.all<{ application_id: number; type: string; at: number; data: string }>(
    `SELECT application_id, type, at, data FROM events WHERE type IN ('status', 'email') ${since ? 'AND at >= ?' : ''} ORDER BY at`,
    since ? [since] : [],
  )
  const firstResponse = new Map<number, number>()
  const maxStage = new Map<number, number>()
  for (const e of events) {
    const d = json.parse<{ to?: string; category?: string }>(e.data, {})
    const responded = (e.type === 'status' && d.to && RESPONSE_STATUSES.has(d.to)) || (e.type === 'email' && d.category && RESPONSE_MAIL.has(d.category))
    if (responded && !firstResponse.has(e.application_id)) firstResponse.set(e.application_id, e.at)
    const st = d.to ? STAGE[d.to as AppStatus] : undefined
    if (st) maxStage.set(e.application_id, Math.max(maxStage.get(e.application_id) ?? 0, st))
  }

  const rows = apps.map((a) => {
    const respondedAt = firstResponse.get(a.id)
    const stage = Math.max(maxStage.get(a.id) ?? 0, STAGE[a.status] ?? 0)
    const days = a.posted_at ? Math.max(0, Math.floor((a.applied_at - a.posted_at) / DAY)) : null
    return { a, responded: respondedAt !== undefined && respondedAt >= a.applied_at, respondedAt, stage, days }
  })
  const delays = rows.filter((r) => r.responded).map((r) => (r.respondedAt! - r.a.applied_at) / DAY).sort((x, y) => x - y)
  const median = delays.length ? delays[Math.floor((delays.length - 1) / 2)]! : null

  const bucket = (d: number | null) => (d === null ? 'Unknown' : d <= 3 ? '0 to 3 days' : d <= 7 ? '4 to 7 days' : d <= 14 ? '8 to 14 days' : '15 days or more')
  const channel = (a: (typeof apps)[number]) => (a.method === 'agent' ? 'Applied by OpenApplyr' : a.method === 'assisted' ? 'Filled, submitted by you' : a.channel === 'referral' ? 'Referral' : a.channel === 'email' ? 'Email' : 'Added by hand')
  const byDays = rates(rows.map((r) => ({ key: bucket(r.days), responded: r.responded })))

  const weekStart = monday(now) - 11 * 7 * DAY
  const weeks = new Map<number, WeekRow>()
  for (let w = weekStart; w <= monday(now); w += 7 * DAY) weeks.set(w, { week: w, applied: 0, responses: 0, spend: 0 })
  for (const r of rows) {
    const w = weeks.get(monday(r.a.applied_at))
    if (w) w.applied++
    if (r.responded) {
      const rw = weeks.get(monday(r.respondedAt!))
      if (rw) rw.responses++
    }
  }
  for (const s of db.all<{ at: number; cost: number | null }>('SELECT at, cost FROM ai_ledger WHERE at >= ?', [weekStart])) {
    const w = weeks.get(monday(s.at))
    if (w && s.cost) w.spend += s.cost
  }
  const total = db.get<{ c: number | null }>(`SELECT SUM(cost) c FROM ai_ledger ${since ? 'WHERE at >= ?' : ''}`, since ? [since] : [])!.c ?? 0

  // "What's working": only comparisons where both sides have at least MIN_GROUP applications.
  const notes: string[] = []
  const early = rows.filter((r) => r.days !== null && r.days <= 3)
  const late = rows.filter((r) => r.days !== null && r.days > 3)
  if (early.length >= MIN_GROUP && late.length >= MIN_GROUP) {
    const [e] = rates(early.map((r) => ({ key: 'early', responded: r.responded })))
    const [l] = rates(late.map((r) => ({ key: 'late', responded: r.responded })))
    notes.push(`Applications sent within 3 days of posting got a response ${pct(e!)}; later ones ${pct(l!)}.`)
  }
  for (const [label, groups] of [
    ['resume template', rates(rows.filter((r) => r.a.template_id).map((r) => ({ key: r.a.template_id!, responded: r.responded })))],
    ['channel', rates(rows.map((r) => ({ key: channel(r.a), responded: r.responded })))],
  ] as const) {
    const big = groups.filter((g) => g.applied >= MIN_GROUP).sort((a, b) => b.rate - a.rate)
    if (big.length >= 2 && big[0]!.rate > big.at(-1)!.rate) notes.push(`By ${label}: ${big.map((g) => `${g.key} ${pct(g)}`).join('; ')}.`)
  }

  return {
    since,
    applied: rows.length,
    responded: rows.filter((r) => r.responded).length,
    screen: rows.filter((r) => r.stage >= 1).length,
    interview: rows.filter((r) => r.stage >= 2).length,
    offer: rows.filter((r) => r.stage >= 3).length,
    rejected: rows.filter((r) => r.a.status === 'rejected').length,
    ghosted: rows.filter((r) => r.a.status === 'ghosted').length,
    medianDaysToResponse: median === null ? null : Math.round(median * 10) / 10,
    byChannel: rates(rows.map((r) => ({ key: channel(r.a), responded: r.responded }))),
    byTemplate: rates(rows.map((r) => ({ key: r.a.template_id ?? 'Not recorded', responded: r.responded }))),
    byHunt: rates(rows.map((r) => ({ key: r.a.hunt ?? 'No hunt', responded: r.responded }))),
    byTitle: rates(rows.map((r) => ({ key: titleKey(r.a.title) || r.a.title, responded: r.responded }))).slice(0, 12),
    byDaysAfterPosting: byDays,
    weekly: [...weeks.values()],
    spend: { total, perApplication: rows.length ? total / rows.length : null },
    notes,
  }
}
