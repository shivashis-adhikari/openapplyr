import type { Ctx } from './engine'

type Kind = 'needs_you' | 'reply' | 'matches' | 'summary' | 'info'

function inQuietHours(start: string, end: string, now: Date): boolean {
  const m = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number) as [number, number]
  const [eh, em] = end.split(':').map(Number) as [number, number]
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? m >= s && m < e : m >= s || m < e
}

/**
 * OS notifications with the rules from the design: needs-you and replies immediately, new matches as a
 * digest at most every two hours, nothing during quiet hours except needs-you items the user must act on.
 * Every notification is also kept in the notifications table for the Today screen.
 */
export class Notifier {
  private pendingMatches = 0
  private lastDigestAt = 0

  constructor(private readonly ctx: Ctx) {}

  private async send(kind: Kind, title: string, body: string, route?: string): Promise<void> {
    const { ctx } = this
    ctx.db.run('INSERT INTO notifications (kind, title, body, route, created_at) VALUES (?, ?, ?, ?, ?)', [kind, title, body, route ?? null, ctx.now()])
    ctx.bus.changed('notifications')
    const n = ctx.settings.get().notifications
    const enabled = kind === 'needs_you' ? n.needsYou : kind === 'reply' ? n.replies : kind === 'matches' ? n.matchesDigest : kind === 'summary' ? n.eveningSummary : true
    if (!enabled) return
    if (kind !== 'needs_you' && n.quietHours.enabled && inQuietHours(n.quietHours.start, n.quietHours.end, new Date(ctx.now()))) return
    try {
      await ctx.host.request('notify', { title, body, ...(route ? { route } : {}) })
    } catch (err) {
      ctx.log.warn('notification failed', { err })
    }
  }

  needsYou(title: string, body: string, route: string): Promise<void> {
    return this.send('needs_you', title, body, route)
  }

  reply(title: string, body: string, route: string): Promise<void> {
    return this.send('reply', title, body, route)
  }

  info(title: string, body: string, route?: string): Promise<void> {
    return this.send('info', title, body, route)
  }

  /** Counts new strong matches and sends one digest at most every two hours. */
  matches(count: number): void {
    this.pendingMatches += count
    this.flushMatches()
  }

  flushMatches(): void {
    if (this.pendingMatches === 0 || this.ctx.now() - this.lastDigestAt < 2 * 3600_000) return
    const n = this.pendingMatches
    this.pendingMatches = 0
    this.lastDigestAt = this.ctx.now()
    void this.send('matches', `${n} new ${n === 1 ? 'match' : 'matches'}`, n === 1 ? 'A job scored above your queue threshold.' : `${n} jobs scored above your queue threshold.`, '/jobs')
  }
}

export { inQuietHours }
