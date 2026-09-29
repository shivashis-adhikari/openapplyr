import type { InboxItem, MailAccountInfo } from '../../shared/api/mail'
import { startOfDay } from '../ai/ledger'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import type { Notifier } from '../notify'
import type { Services } from '../services'
import { addEvent, setStatus } from '../tracker/applications'
import { authorize } from './oauth'
import { PRESETS, presetFor } from './presets'
import { classificationOf } from './process'
import { type AccountConfig, type AccountRow, account, fetchBody, syncAccount, verifyAccount } from './transport'

type Row = AccountRow & { status_detail: string | null }

function info(ctx: Ctx, r: Row): MailAccountInfo {
  const sentToday = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM outreach WHERE account_id = ? AND status = 'sent' AND sent_at >= ?", [r.id, startOfDay(ctx.now())])!.n
  return { id: r.id, provider: r.provider, address: r.address, displayName: r.display_name, status: r.status, statusDetail: r.status_detail, lastSyncAt: r.last_sync_at, dailyCap: r.daily_cap, sentToday }
}

export function registerMailHandlers(ctx: Ctx, s: Services, notifier: Notifier | null): void {
  const { router, db } = ctx
  const accounts = () => db.all<Row>('SELECT * FROM mail_accounts ORDER BY created_at').map((r) => info(ctx, r))
  const byId = (id: number) => info(ctx, db.get<Row>('SELECT * FROM mail_accounts WHERE id = ?', [id])!)
  const queueSync = (id: number, soon = true) => ctx.queue.enqueue('mail.sync', { id }, { dedupeKey: `mail:${id}`, priority: soon ? 10 : 0 })

  /** Stores the account only after both servers accepted the credentials. */
  async function save(address: string, provider: string, cfg: AccountConfig, secret: Record<string, unknown>, displayName: string | undefined): Promise<MailAccountInfo> {
    const existing = db.get<{ id: number; secret_id: number | null }>('SELECT id, secret_id FROM mail_accounts WHERE lower(address) = lower(?)', [address])
    const secretId = ctx.secrets.upsert(existing?.secret_id, JSON.stringify(secret))
    const probe = { id: existing?.id ?? 0, provider, address, display_name: displayName ?? null, config: JSON.stringify(cfg), secret_id: secretId, status: 'ok', daily_cap: 20, cursor: '{}', last_sync_at: null, cfg }
    try {
      await verifyAccount(ctx, probe)
    } catch (err) {
      if (!existing) ctx.secrets.delete(secretId)
      throw err
    }
    const id = existing
      ? (db.run("UPDATE mail_accounts SET provider = ?, config = ?, secret_id = ?, display_name = COALESCE(?, display_name), status = 'ok', status_detail = NULL WHERE id = ?", [provider, JSON.stringify(cfg), secretId, displayName ?? null, existing.id]), existing.id)
      : db.run('INSERT INTO mail_accounts (provider, address, display_name, config, secret_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [provider, address, displayName ?? null, JSON.stringify(cfg), secretId, ctx.now()]).lastInsertRowid
    queueSync(id)
    ctx.bus.changed('mail')
    return byId(id)
  }

  router.on('mail.presets', () => PRESETS.map((p) => ({ id: p.id, label: p.label, auth: p.auth, helpUrl: p.helpUrl, needsServers: !p.imap })))
  router.on('mail.accounts', accounts)

  router.on('mail.connect', async ({ preset, address, password, displayName, imap, smtp }) => {
    const p = presetFor(preset)
    if (p.auth === 'oauth') throw new AppError('USE_OAUTH', `${p.label} needs a browser sign-in. Choose "Sign in with Microsoft".`, { permanent: true })
    const cfg: AccountConfig = { preset: p.id, imap: imap ?? p.imap!, smtp: smtp ?? p.smtp!, auth: 'password', appendSent: p.appendSent }
    if (!cfg.imap || !cfg.smtp) throw new AppError('SERVERS', 'Enter the IMAP and SMTP servers for this account.', { permanent: true })
    // App passwords are often shown with spaces ("abcd efgh ijkl mnop"); providers accept them without.
    return save(address, p.id, cfg, { password: p.id === 'gmail' ? password.replace(/\s+/g, '') : password }, displayName)
  })

  router.on('mail.connectOAuth', async ({ provider, clientId, clientSecret, address, displayName }) => {
    const tokens = await authorize(ctx, { provider, clientId, clientSecret }, address)
    const email = address ?? tokens.email
    if (!email) throw new AppError('OAUTH', 'The sign-in did not say which address it was for. Enter the address and try again.', { permanent: true })
    const p = presetFor(provider === 'microsoft' ? 'outlook' : 'gmail')
    const cfg: AccountConfig = { preset: p.id, imap: p.imap!, smtp: p.smtp!, auth: 'oauth', oauth: { provider, clientId }, appendSent: p.appendSent }
    return save(email, p.id, cfg, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, ...(clientSecret ? { clientSecret } : {}) }, displayName)
  })

  router.on('mail.update', ({ id, dailyCap, displayName }) => {
    account(ctx, id)
    if (dailyCap !== undefined) db.run('UPDATE mail_accounts SET daily_cap = ? WHERE id = ?', [dailyCap, id])
    if (displayName !== undefined) db.run('UPDATE mail_accounts SET display_name = ? WHERE id = ?', [displayName, id])
    ctx.bus.changed('mail')
    return null
  })

  router.on('mail.disconnect', ({ id }) => {
    const a = account(ctx, id)
    db.run('DELETE FROM mail_accounts WHERE id = ?', [id])
    ctx.secrets.delete(a.secret_id)
    ctx.queue.cancel({ dedupeKey: `mail:${id}` })
    ctx.bus.changed('mail')
    return null
  })

  router.on('mail.syncNow', ({ id }) => {
    for (const a of id ? [{ id }] : db.all<{ id: number }>('SELECT id FROM mail_accounts')) queueSync(a.id)
    return null
  })

  router.on('inbox.list', ({ filter, q }) => {
    const where = [filter === 'review' ? 'm.needs_review = 1' : filter === 'linked' ? 'm.application_id IS NOT NULL' : '1 = 1', "m.direction = 'in'"]
    const args: string[] = []
    if (q.trim()) {
      where.push('(m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ?)')
      const like = `%${q.trim().replace(/[%_]/g, '')}%`
      args.push(like, like, like)
    }
    return db
      .all<{ id: number; account_id: number; from_addr: string; from_name: string | null; subject: string | null; snippet: string | null; date: number; classification: string | null; application_id: number | null; company_name: string | null; title: string | null; needs_review: number }>(
        `SELECT m.*, a.company_name, a.title FROM mail_messages m LEFT JOIN applications a ON a.id = m.application_id WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT 500`,
        args,
      )
      .map((m): InboxItem => {
        const c = classificationOf(m.classification)
        return {
          id: m.id,
          accountId: m.account_id,
          from: m.from_addr,
          fromName: m.from_name ?? '',
          subject: m.subject ?? '',
          snippet: m.snippet ?? '',
          date: m.date,
          category: c?.category ?? null,
          confidence: c?.confidence ?? null,
          code: c?.code ?? null,
          applicationId: m.application_id,
          company: m.company_name,
          title: m.title,
          needsReview: !!m.needs_review,
          suggestions: c?.suggestions ?? [],
          suggestedStatus: c?.suggestedStatus ?? null,
        }
      })
  })

  router.on('inbox.body', async ({ id }) => ({ text: await fetchBody(ctx, id) }))

  router.on('inbox.resolve', ({ id, applicationId, status }) => {
    const m = db.get<{ subject: string | null; from_addr: string; date: number; classification: string | null }>('SELECT subject, from_addr, date, classification FROM mail_messages WHERE id = ?', [id])
    if (!m) throw new AppError('NOT_FOUND', 'That message is no longer stored.', { permanent: true })
    db.tx(() => {
      db.run('UPDATE mail_messages SET application_id = ?, needs_review = 0, handled = 1 WHERE id = ?', [applicationId, id])
      if (applicationId) {
        addEvent(db, applicationId, 'email', 'user', { messageId: id, category: classificationOf(m.classification)?.category ?? 'other', subject: m.subject, from: m.from_addr }, m.date)
        if (status) setStatus(db, applicationId, status, 'user', { messageId: id }, ctx.now())
      }
    })
    ctx.bus.changed('mail', 'applications')
    return null
  })

  router.on('inbox.dismiss', ({ id }) => {
    db.run('UPDATE mail_messages SET needs_review = 0, handled = 1 WHERE id = ?', [id])
    ctx.bus.changed('mail')
    return null
  })

  ctx.worker.register('mail.sync', async (payload, t) => void (await syncAccount(ctx, s, notifier, (payload as { id: number }).id, t.signal)), { concurrency: 2, timeoutMs: 10 * 60_000 })
}

/** Every 5 minutes for accounts that are signed in. */
export function scheduleMailSync(ctx: Ctx): void {
  for (const a of ctx.db.all<{ id: number }>("SELECT id FROM mail_accounts WHERE status != 'auth_error'")) {
    ctx.queue.enqueue('mail.sync', { id: a.id }, { dedupeKey: `mail:${a.id}` })
  }
}
