import type { ContactInfo, OutreachItem } from '../../shared/api/outreach'
import type { Judgment } from '../../shared/domain'
import { json } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { discoverContacts } from '../contacts/discover'
import { companyKey } from '../jobs/classify'
import { upsertCompany } from '../jobs/ingest'
import { huntFor } from '../match/hunts'
import { loadProfile, loadVoice } from '../profile/store'
import type { Services } from '../services'
import { type Purpose, writeDraft } from './draft'
import { createSequence, nextSendWindow, sendDue } from './sequence'

type ContactRow = { id: number; name: string; title: string | null; relation: string; email: string | null; email_status: string; linkedin_url: string | null; company_name: string | null; source: string; confidence: number; do_not_contact: number; last_contacted_at: number | null; notes: string }
const contactInfo = (r: ContactRow): ContactInfo => ({
  id: r.id,
  name: r.name,
  title: r.title,
  relation: r.relation,
  email: r.email,
  emailStatus: r.email_status,
  linkedinUrl: r.linkedin_url,
  company: r.company_name,
  source: r.source,
  confidence: r.confidence,
  doNotContact: !!r.do_not_contact,
  lastContactedAt: r.last_contacted_at,
  notes: r.notes,
})

type OutreachRow = {
  id: number
  thread_key: string | null
  application_id: number | null
  contact_id: number
  channel: string
  step: number
  purpose: string
  subject: string | null
  body: string
  attach_resume: number
  status: OutreachItem['status']
  scheduled_at: number | null
  sent_at: number | null
  error: string | null
  name: string
  title: string | null
  email: string | null
  email_status: string
  company_name: string | null
  job_title: string | null
}
const OUTREACH_SELECT = `SELECT o.*, c.name, c.title, c.email, c.email_status, COALESCE(a.company_name, c.company_name) company_name, a.title job_title
  FROM outreach o JOIN contacts c ON c.id = o.contact_id LEFT JOIN applications a ON a.id = o.application_id`
const outreachItem = (r: OutreachRow): OutreachItem => ({
  id: r.id,
  threadKey: r.thread_key,
  applicationId: r.application_id,
  contact: { id: r.contact_id, name: r.name, title: r.title, email: r.email, emailStatus: r.email_status },
  company: r.company_name,
  jobTitle: r.job_title,
  channel: r.channel,
  step: r.step,
  purpose: r.purpose,
  subject: r.subject,
  body: r.body,
  attachResume: !!r.attach_resume,
  status: r.status,
  scheduledAt: r.scheduled_at,
  sentAt: r.sent_at,
  error: r.error,
})

/** Drafts the first message for an application and contact, with follow-ups, as one sequence. */
export async function draftSequence(ctx: Ctx, s: Services, applicationId: number, contactId: number, purpose: Purpose, o: { notes?: string | undefined; schedule: boolean }) {
  const { db } = ctx
  const app = db.get<{ job_id: number | null; hunt_id: number | null; title: string; company_name: string; status: string; applied_at: number | null }>('SELECT job_id, hunt_id, title, company_name, status, applied_at FROM applications WHERE id = ?', [applicationId])
  if (!app) throw new AppError('NOT_FOUND', 'That application no longer exists.', { permanent: true })
  const contact = db.get<{ name: string; title: string | null }>('SELECT name, title FROM contacts WHERE id = ?', [contactId])
  if (!contact) throw new AppError('NOT_FOUND', 'That contact no longer exists.', { permanent: true })
  const job = app.job_id ? db.get<{ description_md: string }>('SELECT description_md FROM jobs WHERE id = ?', [app.job_id]) : undefined
  const judgment = app.job_id && app.hunt_id ? json.parse<Judgment | null>(db.get<{ judgment: string | null }>('SELECT judgment FROM job_scores WHERE job_id = ? AND hunt_id = ?', [app.job_id, app.hunt_id])?.judgment, null) : null
  const hunt = huntFor(db, app.hunt_id)
  const d = await writeDraft(s.ai, {
    profile: loadProfile(db).profile,
    voice: loadVoice(db).description,
    purpose,
    contact,
    job: { title: app.title, company: app.company_name, description: job?.description_md ?? '' },
    judgment,
    applied: !!app.applied_at,
    notes: o.notes,
  })
  const id = createSequence(ctx, {
    applicationId,
    contactId,
    purpose,
    subject: d.subject,
    body: d.body,
    attachResume: purpose === 'hiring_manager',
    accountId: null,
    // Anything the checks flag waits for the user, even in autopilot.
    schedule: o.schedule && d.issues.length === 0,
    followUpDays: purpose === 'follow_up' ? [] : hunt.config.outreach.followUpDays,
  })
  return { id, issues: d.issues }
}

export function registerOutreachHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx
  const outreach = (id: number) => {
    const r = db.get<OutreachRow>(`${OUTREACH_SELECT} WHERE o.id = ?`, [id])
    if (!r) throw new AppError('NOT_FOUND', 'That message no longer exists.', { permanent: true })
    return outreachItem(r)
  }
  const contact = (id: number) => contactInfo(db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', [id])!)

  router.on('contacts.list', ({ q, applicationId }) => {
    const where: string[] = []
    const args: (string | number)[] = []
    if (applicationId) {
      where.push('(c.company_id = (SELECT company_id FROM applications WHERE id = ?) OR c.id IN (SELECT contact_id FROM outreach WHERE application_id = ?))')
      args.push(applicationId, applicationId)
    }
    if (q.trim()) {
      const like = `%${q.trim().replace(/[%_]/g, '')}%`
      where.push('(c.name LIKE ? OR c.email LIKE ? OR c.company_name LIKE ? OR c.title LIKE ?)')
      args.push(like, like, like, like)
    }
    return db.all<ContactRow>(`SELECT c.* FROM contacts c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT 1000`, args).map(contactInfo)
  })

  router.on('contacts.save', (c) => {
    const companyId = c.company ? upsertCompany(db, c.company, { now: ctx.now() }) : null
    const email = c.email?.toLowerCase() ?? null
    const clash = email ? db.get<{ id: number }>('SELECT id FROM contacts WHERE lower(email) = ? AND id != ?', [email, c.id ?? 0]) : undefined
    if (clash) throw new AppError('DUPLICATE', 'Another contact already has that email address.', { permanent: true })
    const id = c.id
      ? (db.run('UPDATE contacts SET name = ?, title = ?, email = ?, linkedin_url = ?, company_id = ?, company_name = ?, notes = ? WHERE id = ?', [c.name, c.title, email, c.linkedinUrl, companyId, c.company, c.notes, c.id]), c.id)
      : db.run("INSERT INTO contacts (company_id, company_name, name, title, email, email_status, linkedin_url, source, confidence, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?)", [
          companyId,
          c.company,
          c.name,
          c.title,
          email,
          email ? 'likely' : 'unknown',
          c.linkedinUrl,
          c.notes,
          ctx.now(),
        ]).lastInsertRowid
    ctx.bus.changed('contacts')
    return contact(id)
  })

  router.on('contacts.delete', ({ id }) => {
    db.run('DELETE FROM contacts WHERE id = ?', [id])
    ctx.bus.changed('contacts', 'outreach')
    return null
  })

  router.on('contacts.setDoNotContact', ({ id, value }) => {
    db.run('UPDATE contacts SET do_not_contact = ? WHERE id = ?', [value ? 1 : 0, id])
    if (value) db.run("UPDATE outreach SET status = 'cancelled', error = 'Marked do not contact.' WHERE contact_id = ? AND status IN ('draft', 'scheduled')", [id])
    ctx.bus.changed('contacts', 'outreach')
    return null
  })

  router.on('contacts.discover', async ({ applicationId }) => (await discoverContacts(ctx, s, applicationId)).map(contact))

  router.on('outreach.list', ({ filter, applicationId }) => {
    const status = { drafts: "o.status = 'draft'", scheduled: "o.status = 'scheduled'", sent: "o.status IN ('sent', 'failed')", all: '1 = 1' }[filter]
    return db.all<OutreachRow>(`${OUTREACH_SELECT} WHERE ${status} ${applicationId ? 'AND o.application_id = ?' : ''} ORDER BY COALESCE(o.sent_at, o.scheduled_at, o.created_at) ${filter === 'sent' ? 'DESC' : 'ASC'} LIMIT 500`, applicationId ? [applicationId] : []).map(outreachItem)
  })

  router.on('outreach.draft', async ({ applicationId, contactId, purpose, notes }) => {
    const r = await draftSequence(ctx, s, applicationId, contactId, purpose, { notes, schedule: false })
    return { item: outreach(r.id), issues: r.issues }
  })

  router.on('outreach.update', ({ id, subject, body, attachResume }) => {
    const o = outreach(id)
    if (o.status !== 'draft' && o.status !== 'scheduled') throw new AppError('SENT', 'This message was already sent.', { permanent: true })
    db.run('UPDATE outreach SET subject = COALESCE(?, subject), body = COALESCE(?, body), attach_resume = COALESCE(?, attach_resume) WHERE id = ?', [subject ?? null, body ?? null, attachResume === undefined ? null : attachResume ? 1 : 0, id])
    ctx.bus.changed('outreach')
    return outreach(id)
  })

  router.on('outreach.approve', ({ ids }) => {
    let scheduled = 0
    const first = nextSendWindow(ctx.now())
    for (const id of ids) {
      const o = outreach(id)
      // Approving the first message approves its follow-ups; they keep their business-day gaps.
      const r = db.run("UPDATE outreach SET status = 'scheduled', scheduled_at = CASE WHEN step = 0 THEN MAX(COALESCE(scheduled_at, 0), ?) ELSE scheduled_at END WHERE thread_key = ? AND status = 'draft'", [first, o.threadKey ?? String(o.id)])
      scheduled += r.changes
    }
    ctx.bus.changed('outreach')
    return { scheduled }
  })

  router.on('outreach.cancel', ({ ids }) => {
    for (const id of ids) {
      const o = outreach(id)
      db.run("UPDATE outreach SET status = 'cancelled', error = 'Cancelled by you.' WHERE thread_key = ? AND step >= ? AND status IN ('draft', 'scheduled')", [o.threadKey ?? String(o.id), o.step])
    }
    ctx.bus.changed('outreach')
    return null
  })

  router.on('outreach.sendNow', ({ id }) => {
    const o = outreach(id)
    if (o.status !== 'draft' && o.status !== 'scheduled') throw new AppError('SENT', 'This message was already sent.', { permanent: true })
    db.run("UPDATE outreach SET status = 'scheduled', scheduled_at = ? WHERE id = ?", [ctx.now(), id])
    db.run("UPDATE outreach SET status = 'scheduled' WHERE thread_key = ? AND step > ? AND status = 'draft'", [o.threadKey ?? String(o.id), o.step])
    ctx.queue.enqueue('outreach.send', {}, { dedupeKey: 'outreach.send', priority: 50 })
    ctx.bus.changed('outreach')
    return null
  })

  ctx.worker.register('outreach.send', async () => void (await sendDue(ctx)), { concurrency: 1, timeoutMs: 10 * 60_000 })

  // After an application goes out, a hunt with outreach on finds people and drafts (or schedules) a note.
  ctx.worker.register(
    'outreach.plan',
    async (payload) => {
      const { applicationId } = payload as { applicationId: number }
      const app = db.get<{ hunt_id: number | null; company_name: string }>('SELECT hunt_id, company_name FROM applications WHERE id = ?', [applicationId])
      if (!app) return
      const hunt = huntFor(db, app.hunt_id)
      if (!hunt.config.outreach.enabled) return
      const today = db.get<{ n: number }>("SELECT COUNT(*) n FROM outreach o JOIN applications a ON a.id = o.application_id WHERE a.hunt_id IS ? AND o.step = 0 AND o.created_at >= ?", [app.hunt_id, ctx.now() - 86_400_000])!.n
      if (today >= hunt.config.outreach.dailyCap) return
      const ids = await discoverContacts(ctx, s, applicationId)
      const best = ids.map((id) => db.get<{ id: number; relation: string; email_status: string }>('SELECT id, relation, email_status FROM contacts WHERE id = ?', [id])!).find((c) => ['recruiter', 'hiring_manager'].includes(c.relation))
      if (!best) return
      try {
        await draftSequence(ctx, s, applicationId, best.id, best.relation === 'hiring_manager' ? 'hiring_manager' : 'recruiter_intro', {
          // Guessed addresses always wait for the user.
          schedule: hunt.mode === 'autopilot' && hunt.config.outreach.autopilot && best.email_status !== 'guessed',
        })
      } catch (err) {
        ctx.log.info('outreach not planned', { applicationId, company: companyKey(app.company_name), reason: errorMessage(err) })
      }
    },
    { concurrency: 1, timeoutMs: 5 * 60_000 },
  )
}
