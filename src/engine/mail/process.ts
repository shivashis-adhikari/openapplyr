import type { AppStatus } from '../../shared/domain'
import { json } from '../core/db'
import type { Db } from '../core/db'
import type { Ctx } from '../engine'
import { companyKey, titleKey } from '../jobs/classify'
import type { Notifier } from '../notify'
import type { Services } from '../services'
import { addEvent, setStatus } from '../tracker/applications'
import { fold } from '../util/text'
import { type Classification, type MailInput, classifyByRules, classifyMailPrompt, isOptOut, parseIcs, prefilter } from './classify'

export type ParsedMail = MailInput & {
  messageId: string
  references: string[]
  direction: 'in' | 'out'
  folder: string
  uid: number | null
  ics: string[]
}

export type Suggestion = { applicationId: number; company: string; title: string; score: number }
export type Link = { applicationId: number | null; contactId: number | null; confidence: number; suggestions: Suggestion[] }

const LIVE = "a.archived = 0 AND a.status NOT IN ('accepted', 'declined', 'withdrawn')"
const domainOf = (addr: string) => addr.split('@')[1]?.toLowerCase() ?? ''

export function knownSets(db: Db): { domains: Set<string>; contacts: Set<string>; sentIds: Set<string> } {
  const domains = new Set(
    db
      .all<{ domain: string }>(`SELECT DISTINCT co.domain FROM applications a JOIN companies co ON co.id = a.company_id WHERE ${LIVE} AND co.domain IS NOT NULL`)
      .map((r) => r.domain.toLowerCase().replace(/^www\./, '')),
  )
  const contacts = new Set(db.all<{ email: string }>('SELECT lower(email) email FROM contacts WHERE email IS NOT NULL').map((r) => r.email))
  const sentIds = new Set([
    ...db.all<{ message_id: string }>('SELECT message_id FROM outreach WHERE message_id IS NOT NULL').map((r) => r.message_id),
    ...db.all<{ message_id: string }>("SELECT message_id FROM mail_messages WHERE direction = 'out'").map((r) => r.message_id),
  ])
  return { domains, contacts, sentIds }
}

/** Finds the application a message is about. Unclear cases return suggestions instead of a guess. */
export function linkMessage(db: Db, m: ParsedMail, cls: Classification): Link {
  const threadIds = [m.inReplyTo, ...m.references].filter((x): x is string => !!x)
  if (threadIds.length) {
    const o = db.get<{ application_id: number | null; contact_id: number }>(
      `SELECT application_id, contact_id FROM outreach WHERE message_id IN (${threadIds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
      threadIds,
    )
    if (o) return { applicationId: o.application_id, contactId: o.contact_id, confidence: 1, suggestions: [] }
  }
  const contact = db.get<{ id: number; company_id: number | null }>('SELECT id, company_id FROM contacts WHERE lower(email) = ?', [m.from.toLowerCase()])
  const domain = domainOf(m.from)
  const text = fold(`${m.subject} ${m.text.slice(0, 3000)}`)
  const apps = db.all<{ id: number; company_name: string; title: string; company_id: number | null; domain: string | null; applied_at: number | null; created_at: number }>(
    `SELECT a.id, a.company_name, a.title, a.company_id, co.domain, a.applied_at, a.created_at FROM applications a LEFT JOIN companies co ON co.id = a.company_id WHERE ${LIVE} ORDER BY a.created_at DESC LIMIT 500`,
  )
  const hint = cls.company ? companyKey(cls.company) : ''
  const scored = apps
    .map((a) => {
      let score = 0
      const key = companyKey(a.company_name)
      if (a.domain && (domain === a.domain || domain.endsWith(`.${a.domain.replace(/^www\./, '')}`))) score += 0.6
      if (contact?.company_id && contact.company_id === a.company_id) score += 0.5
      if (hint && key && (hint === key || hint.includes(key) || key.includes(hint))) score += 0.5
      else if (key.length > 2 && new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) score += 0.3
      const words = titleKey(a.title).split(' ').filter((w) => w.length > 2)
      if (words.length && words.filter((w) => text.includes(w)).length / words.length >= 0.6) score += 0.2
      if (cls.role && titleKey(cls.role) === titleKey(a.title)) score += 0.2
      if (m.date - (a.applied_at ?? a.created_at) < 60 * 86_400_000 && m.date >= (a.applied_at ?? a.created_at) - 86_400_000) score += 0.1
      return { applicationId: a.id, company: a.company_name, title: a.title, score: Math.round(score * 100) / 100 }
    })
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
  const [best, second] = scored
  if (best && best.score >= 0.6 && (!second || second.score <= best.score - 0.2)) {
    return { applicationId: best.applicationId, contactId: contact?.id ?? null, confidence: Math.min(0.95, best.score), suggestions: [] }
  }
  return { applicationId: null, contactId: contact?.id ?? null, confidence: 0, suggestions: scored.slice(0, 3) }
}

/** The status a message implies for an application in its current status, or null. */
export function statusFor(category: Classification['category'], current: AppStatus): AppStatus | null {
  switch (category) {
    case 'application_received':
      return current === 'applied_unverified' ? 'applied' : null
    case 'rejection':
      return 'rejected'
    case 'offer':
      return 'offer'
    case 'assessment':
      return 'screening'
    case 'interview_request':
      return ['applied', 'applied_unverified', 'ghosted'].includes(current) ? 'screening' : current === 'screening' ? 'interviewing' : null
    default:
      return null
  }
}

const REPLY_CATEGORIES = new Set(['rejection', 'interview_request', 'assessment', 'offer', 'positive_reply', 'negative_reply', 'neutral_reply', 'scheduling', 'recruiter_outreach'])

/**
 * Stores a relevant message and applies what it means: a status change (automatically only at 0.8
 * confidence or more, otherwise as a suggestion), stopped follow-ups, an interview from an invite,
 * a permanent opt-out, a notification. Returns the stored row id, or null for mail that is not about
 * the search (nothing is stored for it).
 */
export async function processMessage(ctx: Ctx, s: Services | null, notifier: Notifier | null, accountId: number, m: ParsedMail, known = knownSets(ctx.db)): Promise<number | null> {
  const { db } = ctx
  if (db.get('SELECT 1 FROM mail_messages WHERE account_id = ? AND message_id = ?', [accountId, m.messageId])) return null
  const snippet = m.text.replace(/\s+/g, ' ').trim().slice(0, 300)

  if (m.direction === 'out') {
    // Sent mail: kept only when it went to a known contact, so outreach limits see it.
    const contact = m.to.map((t) => db.get<{ id: number }>('SELECT id FROM contacts WHERE lower(email) = ?', [t.toLowerCase()])).find(Boolean)
    if (!contact) return null
    db.run('UPDATE contacts SET last_contacted_at = MAX(COALESCE(last_contacted_at, 0), ?) WHERE id = ?', [m.date, contact.id])
    return db.run(
      `INSERT INTO mail_messages (account_id, folder, uid, message_id, in_reply_to, refs, from_addr, from_name, to_addrs, subject, date, snippet, direction, contact_id, handled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'out', ?, 1, ?)`,
      [accountId, m.folder, m.uid, m.messageId, m.inReplyTo, JSON.stringify(m.references), m.from, m.fromName, JSON.stringify(m.to), m.subject, m.date, snippet, contact.id, ctx.now()],
    ).lastInsertRowid
  }

  if (!prefilter(m, known)) return null
  let cls = classifyByRules(m, ctx.now())
  if (!cls && s && ctx.settings.get().mail.aiClassification) {
    try {
      const r = await s.ai.structured(classifyMailPrompt, m, { task: 'Sort email' })
      cls = { ...r, code: null, returnDate: null, by: 'model' }
    } catch (err) {
      ctx.log.warn('mail classification failed', { err: String(err) })
    }
  }
  cls ??= { category: 'other', confidence: 0.3, company: null, role: null, code: null, returnDate: null, by: 'rule' }
  const link = linkMessage(db, m, cls)
  const app = link.applicationId ? db.get<{ status: AppStatus; company_name: string; title: string; company_id: number | null }>('SELECT status, company_name, title, company_id FROM applications WHERE id = ?', [link.applicationId]) : undefined
  const suggestedStatus = app ? statusFor(cls.category, app.status) : null
  // Automatic only when both the link and the reading are at least 0.8.
  const sure = Math.min(link.confidence, cls.confidence) >= 0.8
  const relevant = cls.category !== 'other' && cls.category !== 'verification_code'
  const needsReview = relevant && (!link.applicationId ? REPLY_CATEGORIES.has(cls.category) || cls.category === 'application_received' : !!suggestedStatus && !sure)

  const rowId = db.run(
    `INSERT INTO mail_messages (account_id, folder, uid, message_id, in_reply_to, refs, from_addr, from_name, to_addrs, subject, date, snippet, direction, classification, application_id, contact_id, needs_review, handled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      m.folder,
      m.uid,
      m.messageId,
      m.inReplyTo,
      JSON.stringify(m.references),
      m.from,
      m.fromName,
      JSON.stringify(m.to),
      m.subject,
      m.date,
      snippet,
      JSON.stringify({ ...cls, suggestions: link.suggestions, suggestedStatus, linkConfidence: link.confidence }),
      link.applicationId,
      link.contactId,
      needsReview ? 1 : 0,
      needsReview ? 0 : 1,
      ctx.now(),
    ],
  ).lastInsertRowid

  if (link.applicationId && app) {
    addEvent(db, link.applicationId, 'email', 'mail', { messageId: rowId, category: cls.category, subject: m.subject, from: m.from }, m.date)
    if (suggestedStatus && sure) setStatus(db, link.applicationId, suggestedStatus, 'mail', { messageId: rowId }, m.date)
  }

  // Any reply from the company ends follow-ups to it; an out-of-office pushes them past the return date.
  const companyId = app?.company_id ?? (link.contactId ? (db.get<{ company_id: number | null }>('SELECT company_id FROM contacts WHERE id = ?', [link.contactId])?.company_id ?? null) : null)
  if (cls.category === 'out_of_office' && link.contactId) {
    const until = (cls.returnDate ?? m.date + 7 * 86_400_000) + 86_400_000
    db.run("UPDATE outreach SET scheduled_at = MAX(scheduled_at, ?) WHERE contact_id = ? AND status = 'scheduled'", [until, link.contactId])
  } else if (REPLY_CATEGORIES.has(cls.category) || link.contactId) {
    const where = [link.applicationId ? 'application_id = ?' : null, link.contactId ? 'contact_id = ?' : null, companyId ? 'contact_id IN (SELECT id FROM contacts WHERE company_id = ?)' : null].filter(Boolean)
    const args = [link.applicationId, link.contactId, companyId].filter((x): x is number => x !== null && x !== undefined)
    if (where.length) db.run(`UPDATE outreach SET status = 'cancelled', error = 'They replied.' WHERE status = 'scheduled' AND (${where.join(' OR ')})`, args)
  }
  if (link.contactId && isOptOut(m.text)) {
    db.run('UPDATE contacts SET do_not_contact = 1 WHERE id = ?', [link.contactId])
    db.run("UPDATE outreach SET status = 'cancelled', error = 'They asked not to be contacted.' WHERE contact_id = ? AND status IN ('scheduled', 'draft')", [link.contactId])
  }

  for (const ics of m.ics) {
    const ev = parseIcs(ics)
    if (!ev?.start || !link.applicationId) continue
    if (db.get('SELECT 1 FROM interviews WHERE application_id = ? AND starts_at = ?', [link.applicationId, ev.start])) continue
    const kind = /technical|coding|system design/i.test(`${ev.summary} ${ev.description}`) ? 'technical' : /onsite|on-site|final/i.test(`${ev.summary}`) ? 'onsite' : /recruiter|screen|intro/i.test(`${ev.summary}`) ? 'recruiter' : 'other'
    const id = db.run('INSERT INTO interviews (application_id, starts_at, ends_at, kind, location, link, interviewers, notes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      link.applicationId,
      ev.start,
      ev.end,
      kind,
      ev.location,
      ev.link,
      '[]',
      ev.summary ?? '',
      'mail',
      ctx.now(),
    ]).lastInsertRowid
    addEvent(db, link.applicationId, 'interview', 'mail', { interviewId: id, startsAt: ev.start }, m.date)
    ctx.bus.changed('interviews')
  }

  if (notifier && ['interview_request', 'offer', 'assessment', 'positive_reply', 'neutral_reply', 'scheduling', 'recruiter_outreach'].includes(cls.category)) {
    void notifier.reply(app ? `${app.company_name}: ${app.title}` : m.fromName || m.from, m.subject, `#/inbox?message=${rowId}`)
  }
  ctx.bus.changed('mail', 'applications')
  return rowId
}

export const classificationOf = (raw: string | null) => json.parse<(Classification & { suggestions: Suggestion[]; suggestedStatus: AppStatus | null; linkConfidence: number }) | null>(raw, null)
