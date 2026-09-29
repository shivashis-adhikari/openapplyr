import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { json } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import type { Notifier } from '../notify'
import type { Services } from '../services'
import { type OAuthProvider, refresh } from './oauth'
import type { Server } from './presets'
import { type ParsedMail, knownSets, processMessage } from './process'
import { prefilter } from './classify'

export type AccountConfig = {
  preset: string
  imap: Server
  smtp: Server
  auth: 'password' | 'oauth'
  oauth?: { provider: OAuthProvider; clientId: string }
  appendSent: boolean
}
type Secret = { password?: string; accessToken?: string; refreshToken?: string; expiresAt?: number; clientSecret?: string }
export type AccountRow = { id: number; provider: string; address: string; display_name: string | null; config: string; secret_id: number | null; status: string; daily_cap: number; cursor: string; last_sync_at: number | null }

export function account(ctx: Ctx, id: number): AccountRow & { cfg: AccountConfig } {
  const row = ctx.db.get<AccountRow>('SELECT * FROM mail_accounts WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', 'That mail account is no longer connected.', { permanent: true })
  return { ...row, cfg: json.parse<AccountConfig>(row.config, {} as AccountConfig) }
}

/** Username and password, or a fresh OAuth access token (refreshed two minutes before it expires). */
export async function auth(ctx: Ctx, a: AccountRow & { cfg: AccountConfig }): Promise<{ user: string; pass?: string; accessToken?: string }> {
  const secret = json.parse<Secret>(ctx.secrets.get(a.secret_id), {})
  if (a.cfg.auth === 'password') return { user: a.address, pass: secret.password ?? '' }
  if (!a.cfg.oauth || !secret.refreshToken) throw new AppError('MAIL_AUTH', `Sign in to ${a.address} again in Settings, Email.`, { permanent: true })
  if (secret.accessToken && (secret.expiresAt ?? 0) > Date.now() + 120_000) return { user: a.address, accessToken: secret.accessToken }
  const t = await refresh({ provider: a.cfg.oauth.provider, clientId: a.cfg.oauth.clientId, clientSecret: secret.clientSecret }, secret.refreshToken)
  ctx.secrets.set(a.secret_id!, JSON.stringify({ ...secret, accessToken: t.accessToken, refreshToken: t.refreshToken || secret.refreshToken, expiresAt: t.expiresAt }))
  return { user: a.address, accessToken: t.accessToken }
}

export async function imapClient(ctx: Ctx, a: AccountRow & { cfg: AccountConfig }): Promise<ImapFlow> {
  const cred = await auth(ctx, a)
  const client = new ImapFlow({
    host: a.cfg.imap.host,
    port: a.cfg.imap.port,
    secure: a.cfg.imap.secure,
    auth: cred.accessToken ? { user: cred.user, accessToken: cred.accessToken } : { user: cred.user, pass: cred.pass ?? '' },
    logger: false,
    // Proton Bridge serves a self-signed certificate on localhost.
    ...(a.cfg.imap.host === '127.0.0.1' ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 30_000,
  })
  await client.connect()
  return client
}

export async function smtpTransport(ctx: Ctx, a: AccountRow & { cfg: AccountConfig }) {
  const cred = await auth(ctx, a)
  return nodemailer.createTransport({
    host: a.cfg.smtp.host,
    port: a.cfg.smtp.port,
    secure: a.cfg.smtp.secure,
    requireTLS: !a.cfg.smtp.secure && a.cfg.smtp.host !== '127.0.0.1',
    auth: cred.accessToken ? { type: 'OAuth2', user: cred.user, accessToken: cred.accessToken } : { user: cred.user, pass: cred.pass ?? '' },
    ...(a.cfg.smtp.host === '127.0.0.1' ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 30_000,
  })
}

/** Logs in to both servers; the connect dialog shows the first error in plain words. */
export async function verifyAccount(ctx: Ctx, a: AccountRow & { cfg: AccountConfig }): Promise<void> {
  let client: ImapFlow | null = null
  try {
    client = await imapClient(ctx, a)
  } catch (err) {
    throw new AppError('MAIL_AUTH', `Could not sign in to ${a.cfg.imap.host}: ${mailError(err)}`, { permanent: true })
  } finally {
    await client?.logout().catch(() => undefined)
  }
  try {
    await (await smtpTransport(ctx, a)).verify()
  } catch (err) {
    throw new AppError('MAIL_AUTH', `Reading mail works, but sending through ${a.cfg.smtp.host} failed: ${mailError(err)}`, { permanent: true })
  }
}

function mailError(err: unknown): string {
  const e = err as { authenticationFailed?: boolean; responseText?: string; code?: string }
  if (e.authenticationFailed || /auth|invalid credentials|535/i.test(String(e.responseText ?? err))) return 'the address or app password was not accepted.'
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') return 'the server could not be reached.'
  if (e.code === 'ETIMEDOUT') return 'the server did not answer in time.'
  return errorMessage(err)
}

export type OutgoingMail = {
  to: string
  subject: string
  text: string
  inReplyTo?: string | null | undefined
  references?: string[] | undefined
  attachments?: { filename: string; path: string }[] | undefined
}

/**
 * Sends plain text from the user's own mailbox, with a Message-ID we choose so follow-ups thread and
 * replies link back. No tracking. Files a copy in Sent when the provider does not.
 */
export async function composeMail(from: { address: string; name: string | null }, m: OutgoingMail): Promise<{ raw: Buffer; messageId: string }> {
  const domain = from.address.split('@')[1] ?? 'openapplyr.local'
  const messageId = `<${randomUUID()}@${domain}>`
  const raw = await new MailComposer({
    from: from.name ? { name: from.name, address: from.address } : from.address,
    to: m.to,
    subject: m.subject,
    text: m.text,
    messageId,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: [...(m.references ?? []), m.inReplyTo].join(' ') } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  })
    .compile()
    .build()
  return { raw, messageId }
}

export async function sendMail(ctx: Ctx, accountId: number, m: OutgoingMail): Promise<{ messageId: string }> {
  if (ctx.demo) throw new AppError('SAMPLE_WORKSPACE', 'The sample workspace does not send email.', { permanent: true })
  const a = account(ctx, accountId)
  const { raw, messageId } = await composeMail({ address: a.address, name: a.display_name }, m)
  const transport = await smtpTransport(ctx, a)
  await transport.sendMail({ envelope: { from: a.address, to: [m.to] }, raw })
  if (a.cfg.appendSent) {
    let client: ImapFlow | null = null
    try {
      client = await imapClient(ctx, a)
      const sent = (await client.list()).find((f) => f.specialUse === '\\Sent')?.path ?? 'Sent'
      await client.append(sent, raw, ['\\Seen'])
    } catch (err) {
      ctx.log.warn('could not file sent copy', { err: errorMessage(err) })
    } finally {
      await client?.logout().catch(() => undefined)
    }
  }
  return { messageId }
}

type FolderCursor = { uidValidity: string; lastUid: number }

type AddressObject = { value?: { address?: string; name?: string }[] }
const addrOf = (v: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((o) => o.value ?? []).map((x) => ({ address: (x.address ?? '').toLowerCase(), name: x.name ?? '' }))

/**
 * One sync pass: new messages in the inbox and Sent since the last pass (or the first-sync window).
 * Headers are checked by the prefilter before any body is downloaded.
 */
export async function syncAccount(ctx: Ctx, s: Services | null, notifier: Notifier | null, id: number, signal?: AbortSignal): Promise<{ checked: number; stored: number }> {
  // The sample workspace's mailbox is fictional.
  if (ctx.demo) return { checked: 0, stored: 0 }
  const a = account(ctx, id)
  const cursor = json.parse<Record<string, FolderCursor>>(a.cursor, {})
  const firstSince = new Date(ctx.now() - ctx.settings.get().mail.firstSyncDays * 86_400_000)
  let client: ImapFlow | null = null
  let checked = 0
  let stored = 0
  try {
    client = await imapClient(ctx, a)
    const folders = await client.list()
    const sent = folders.find((f) => f.specialUse === '\\Sent')?.path
    const known = knownSets(ctx.db)
    for (const [folder, direction] of [['INBOX', 'in'], ...(sent ? [[sent, 'out']] : [])] as ['INBOX' | string, 'in' | 'out'][]) {
      if (signal?.aborted) break
      const lock = await client.getMailboxLock(folder)
      try {
        const mb = client.mailbox
        const uidValidity = mb ? String(mb.uidValidity) : ''
        const prev = cursor[folder]
        const fresh = !prev || prev.uidValidity !== uidValidity
        const uids = fresh ? ((await client.search({ since: firstSince }, { uid: true })) || []) : ((await client.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > prev.lastUid)
        let lastUid = fresh ? 0 : prev.lastUid
        for (let i = 0; i < uids.length; i += 200) {
          const batch = uids.slice(i, i + 200)
          const candidates: number[] = []
          for await (const msg of client.fetch(batch.join(','), { uid: true, envelope: true }, { uid: true })) {
            checked++
            lastUid = Math.max(lastUid, msg.uid)
            const env = msg.envelope
            const from = env?.from?.[0]?.address?.toLowerCase() ?? ''
            const to = (env?.to ?? []).map((t) => t.address?.toLowerCase() ?? '')
            const keep = direction === 'out' ? to.some((t) => known.contacts.has(t)) : prefilter({ from, subject: env?.subject ?? '', inReplyTo: env?.inReplyTo ?? null }, known)
            if (keep) candidates.push(msg.uid)
          }
          for (const uid of candidates) {
            if (signal?.aborted) break
            const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
            if (!full || !full.source) continue
            const p = await simpleParser(full.source)
            const fromList = addrOf(p.from)
            const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : []
            const headers: Record<string, string> = {}
            for (const h of ['auto-submitted', 'x-autoreply', 'precedence']) {
              const v = p.headers.get(h)
              if (typeof v === 'string') headers[h] = v
            }
            const parsed: ParsedMail = {
              from: fromList[0]?.address ?? '',
              fromName: fromList[0]?.name ?? '',
              to: addrOf(p.to).map((x) => x.address),
              subject: p.subject ?? '',
              text: (p.text ?? '').slice(0, 20_000),
              date: p.date?.getTime() ?? ctx.now(),
              inReplyTo: p.inReplyTo ?? null,
              headers,
              messageId: p.messageId ?? `<uid-${uid}-${uidValidity}@${a.address}>`,
              references: refs,
              direction,
              folder,
              uid,
              ics: p.attachments.filter((x) => /calendar|\.ics$/i.test(`${x.contentType} ${x.filename ?? ''}`)).map((x) => x.content.toString('utf8')),
            }
            if ((await processMessage(ctx, s, notifier, a.id, parsed, known)) !== null) stored++
          }
        }
        cursor[folder] = { uidValidity, lastUid }
      } finally {
        lock.release()
      }
    }
    ctx.db.run("UPDATE mail_accounts SET cursor = ?, last_sync_at = ?, status = 'ok', status_detail = NULL WHERE id = ?", [JSON.stringify(cursor), ctx.now(), a.id])
    return { checked, stored }
  } catch (err) {
    const permanent = err instanceof AppError ? err.permanent : !!(err as { authenticationFailed?: boolean }).authenticationFailed
    ctx.db.run('UPDATE mail_accounts SET status = ?, status_detail = ? WHERE id = ?', [permanent ? 'auth_error' : 'error', mailError(err), a.id])
    throw err instanceof AppError ? err : new AppError('MAIL_SYNC', `Mail sync for ${a.address} failed: ${mailError(err)}`, { permanent, cause: err })
  } finally {
    await client?.logout().catch(() => undefined)
    ctx.bus.changed('mail')
  }
}

/** The body of a stored message, fetched from the server when opened (bodies are not kept locally). */
export async function fetchBody(ctx: Ctx, messageRowId: number): Promise<string> {
  const m = ctx.db.get<{ account_id: number; folder: string | null; uid: number | null; snippet: string | null }>('SELECT account_id, folder, uid, snippet FROM mail_messages WHERE id = ?', [messageRowId])
  if (!m) throw new AppError('NOT_FOUND', 'That message is no longer stored.', { permanent: true })
  if (!m.folder || !m.uid) return m.snippet ?? ''
  const a = account(ctx, m.account_id)
  const client = await imapClient(ctx, a)
  try {
    const lock = await client.getMailboxLock(m.folder)
    try {
      const full = await client.fetchOne(String(m.uid), { uid: true, source: true }, { uid: true })
      if (!full || !full.source) return m.snippet ?? ''
      return (await simpleParser(full.source)).text ?? ''
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }
}
