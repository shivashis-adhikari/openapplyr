import { startOfDay } from '../ai/ledger'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { renderResume } from '../docs/store'
import { huntFor } from '../match/hunts'
import { loadProfile } from '../profile/store'
import { addEvent } from '../tracker/applications'
import { sendMail } from '../mail/transport'
import { type Purpose, followUpText } from './draft'

const DAY = 86_400_000
export const LIMITS = { perApplication: 2, perCompany30d: 3 }

/** Adds business days (Monday to Friday). */
export function addBusinessDays(t: number, days: number): number {
  const d = new Date(t)
  let left = days
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) left--
  }
  return d.getTime()
}

/**
 * The next good moment to send: a weekday morning (9:00 to 11:30 local), Tuesday to Thursday when one
 * falls within the next four and a half days.
 */
export function nextSendWindow(now: number, random = Math.random): number {
  const slot = (d: Date) => {
    const x = new Date(d)
    x.setHours(9, 0, 0, 0)
    return x.getTime() + Math.floor(random() * 150) * 60_000
  }
  const candidates: number[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    if (d.getDay() === 0 || d.getDay() === 6) continue
    const at = i === 0 ? Math.max(slot(d), now + 5 * 60_000) : slot(d)
    const end = new Date(d)
    end.setHours(11, 30, 0, 0)
    if (at > end.getTime()) continue
    candidates.push(at)
  }
  // A Friday-afternoon draft waits for Tuesday rather than landing in a Monday-morning pile.
  const midweek = candidates.find((t) => [2, 3, 4].includes(new Date(t).getDay()) && t - now < 4.5 * DAY)
  return midweek ?? candidates[0] ?? now + DAY
}

/** Why a contact cannot be written to now, or null when they can. */
export function contactBlock(ctx: Ctx, contactId: number, applicationId: number | null): string | null {
  const { db } = ctx
  const c = db.get<{ do_not_contact: number; company_id: number | null; email: string | null }>('SELECT do_not_contact, company_id, email FROM contacts WHERE id = ?', [contactId])
  if (!c) return 'That contact no longer exists.'
  if (c.do_not_contact) return 'This person asked not to be contacted.'
  if (!c.email) return 'No email address for this person.'
  const since = ctx.now() - 30 * DAY
  // A sequence counts from its first message, whether it is still a draft, scheduled or sent.
  const first = "o.step = 0 AND o.status IN ('draft', 'scheduled', 'sent') AND COALESCE(o.sent_at, o.created_at) >= ?"
  if (db.get(`SELECT 1 FROM outreach o WHERE o.contact_id = ? AND ${first}`, [contactId, since])) return 'You wrote to this person in the last 30 days.'
  if (applicationId) {
    const n = db.get<{ n: number }>(`SELECT COUNT(DISTINCT o.contact_id) n FROM outreach o WHERE o.application_id = ? AND ${first}`, [applicationId, 0])!.n
    if (n >= LIMITS.perApplication) return `At most ${LIMITS.perApplication} people per application.`
  }
  if (c.company_id) {
    const n = db.get<{ n: number }>(`SELECT COUNT(DISTINCT o.contact_id) n FROM outreach o JOIN contacts x ON x.id = o.contact_id WHERE x.company_id = ? AND ${first}`, [c.company_id, since])!.n
    if (n >= LIMITS.perCompany30d) return `At most ${LIMITS.perCompany30d} people at one company in 30 days.`
  }
  return null
}

export type NewSequence = {
  applicationId: number | null
  contactId: number
  purpose: Purpose
  subject: string
  body: string
  attachResume: boolean
  accountId: number | null
  /** Autopilot schedules right away; otherwise everything waits in the Outbox as drafts. */
  schedule: boolean
  followUpDays: number[]
}

/** Step 0 plus up to two follow-ups. Follow-up times are recomputed from the moment the previous step is sent. */
export function createSequence(ctx: Ctx, s: NewSequence): number {
  const block = contactBlock(ctx, s.contactId, s.applicationId)
  if (block) throw new AppError('CONTACT_LIMIT', block, { permanent: true })
  const { db } = ctx
  const now = ctx.now()
  const status = s.schedule ? 'scheduled' : 'draft'
  const first = nextSendWindow(now)
  const firstId = db.run(
    'INSERT INTO outreach (application_id, contact_id, channel, step, purpose, subject, body, attach_resume, status, scheduled_at, account_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)',
    [s.applicationId, s.contactId, s.purpose.startsWith('linkedin') ? 'linkedin' : 'email', s.purpose, s.subject, s.body, s.attachResume ? 1 : 0, status, first, s.accountId, now],
  ).lastInsertRowid
  if (!s.purpose.startsWith('linkedin') && s.purpose !== 'thank_you') {
    const contact = db.get<{ name: string }>('SELECT name FROM contacts WHERE id = ?', [s.contactId])!
    const app = s.applicationId ? db.get<{ title: string; company_name: string; applied_at: number | null }>('SELECT title, company_name, applied_at FROM applications WHERE id = ?', [s.applicationId]) : undefined
    const { profile } = loadProfile(db)
    let at = first
    for (const [i, days] of s.followUpDays.slice(0, 2).entries()) {
      at = addBusinessDays(at, days)
      const body = followUpText((i + 1) as 1 | 2, {
        contactName: contact.name,
        senderName: profile.basics.name,
        title: app?.title ?? 'the',
        company: app?.company_name ?? 'your company',
        appliedOn: app?.applied_at ? new Date(app.applied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null,
      })
      db.run('INSERT INTO outreach (application_id, contact_id, channel, step, purpose, subject, body, status, scheduled_at, account_id, thread_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        s.applicationId,
        s.contactId,
        'email',
        i + 1,
        'follow_up',
        `Re: ${s.subject}`,
        body,
        status,
        at,
        s.accountId,
        String(firstId),
        now,
      ])
    }
  }
  db.run('UPDATE outreach SET thread_key = ? WHERE id = ?', [String(firstId), firstId])
  ctx.bus.changed('outreach')
  return firstId
}

const STOP_STATUSES = ['rejected', 'interviewing', 'offer', 'accepted', 'declined', 'withdrawn']

type DueRow = {
  id: number
  application_id: number | null
  contact_id: number
  step: number
  subject: string | null
  body: string
  attach_resume: number
  account_id: number | null
  thread_key: string | null
  channel: string
}

/**
 * Sends due outreach, one message at a time, re-checking every stop rule just before sending:
 * application outcome, replies, opt-outs and daily limits.
 */
export async function sendDue(ctx: Ctx): Promise<number> {
  const { db } = ctx
  const due = db.all<DueRow>("SELECT * FROM outreach WHERE status = 'scheduled' AND channel = 'email' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20", [ctx.now()])
  let sent = 0
  for (const o of due) {
    const cancel = (why: string) => db.run("UPDATE outreach SET status = 'cancelled', error = ? WHERE thread_key = ? AND status = 'scheduled'", [why, o.thread_key ?? String(o.id)])
    const app = o.application_id ? db.get<{ status: string; package_id: number | null; hunt_id: number | null; company_id: number | null }>('SELECT status, package_id, hunt_id, company_id FROM applications WHERE id = ?', [o.application_id]) : undefined
    if (app && STOP_STATUSES.includes(app.status)) {
      cancel('The application moved on.')
      continue
    }
    const contact = db.get<{ email: string | null; do_not_contact: number; company_id: number | null }>('SELECT email, do_not_contact, company_id FROM contacts WHERE id = ?', [o.contact_id])
    if (!contact?.email || contact.do_not_contact) {
      cancel('This person asked not to be contacted.')
      continue
    }
    const prev = o.step > 0 ? db.get<{ message_id: string | null; sent_at: number | null; status: string }>('SELECT message_id, sent_at, status FROM outreach WHERE thread_key = ? AND step = ?', [o.thread_key, o.step - 1]) : undefined
    if (o.step > 0 && prev?.status !== 'sent') continue
    if (prev?.sent_at && db.get("SELECT 1 FROM mail_messages WHERE direction = 'in' AND date > ? AND (contact_id = ? OR from_addr LIKE ?)", [prev.sent_at, o.contact_id, `%@${contact.email.split('@')[1]}`])) {
      cancel('They replied.')
      continue
    }
    const accountId = o.account_id ?? db.get<{ id: number }>("SELECT id FROM mail_accounts WHERE status = 'ok' ORDER BY id LIMIT 1")?.id
    if (!accountId) {
      db.run("UPDATE outreach SET error = 'Connect an email account in Settings to send.' WHERE id = ?", [o.id])
      continue
    }
    const cap = db.get<{ daily_cap: number }>('SELECT daily_cap FROM mail_accounts WHERE id = ?', [accountId])?.daily_cap ?? 20
    const today = db.get<{ n: number }>("SELECT COUNT(*) n FROM outreach WHERE account_id = ? AND status = 'sent' AND sent_at >= ?", [accountId, startOfDay(ctx.now())])!.n
    if (today >= cap) break
    const hunt = huntFor(db, app?.hunt_id ?? null)
    const root = o.step > 0 ? db.get<{ message_id: string | null }>('SELECT message_id FROM outreach WHERE id = ?', [Number(o.thread_key)]) : undefined
    try {
      const pkg = app?.package_id ? db.get<{ resume_id: number | null }>('SELECT resume_id FROM packages WHERE id = ?', [app.package_id]) : undefined
      const pdf = o.attach_resume && pkg?.resume_id ? (await renderResume(ctx, pkg.resume_id)).pdfPath : null
      const attachments = pdf ? [{ filename: pdf.split(/[\\/]/).pop()!, path: pdf }] : undefined
      const { messageId } = await sendMail(ctx, accountId, {
        to: contact.email,
        subject: o.subject ?? '',
        text: o.body,
        inReplyTo: prev?.message_id ?? null,
        references: root?.message_id && root.message_id !== prev?.message_id ? [root.message_id] : [],
        attachments,
      })
      const now = ctx.now()
      db.tx(() => {
        db.run("UPDATE outreach SET status = 'sent', sent_at = ?, message_id = ?, account_id = ?, error = NULL WHERE id = ?", [now, messageId, accountId, o.id])
        db.run('UPDATE contacts SET last_contacted_at = ? WHERE id = ?', [now, o.contact_id])
        // The next step waits its business days from now, not from when it was drafted.
        const next = db.get<{ id: number }>("SELECT id FROM outreach WHERE thread_key = ? AND step = ? AND status = 'scheduled'", [o.thread_key ?? String(o.id), o.step + 1])
        if (next) db.run('UPDATE outreach SET scheduled_at = ? WHERE id = ?', [addBusinessDays(now, hunt.config.outreach.followUpDays[o.step] ?? 4), next.id])
        if (o.application_id) addEvent(db, o.application_id, 'outreach_sent', 'app', { outreachId: o.id, contactId: o.contact_id, step: o.step }, now)
      })
      sent++
    } catch (err) {
      db.run("UPDATE outreach SET status = 'failed', error = ? WHERE id = ?", [errorMessage(err), o.id])
      ctx.log.warn('outreach send failed', { id: o.id, err: errorMessage(err) })
    }
  }
  if (due.length) ctx.bus.changed('outreach', 'applications')
  return sent
}
