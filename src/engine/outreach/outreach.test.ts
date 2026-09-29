import { describe, expect, it, vi } from 'vitest'
import { heuristicResume, toProfile } from '../profile/extract'
import { saveProfile } from '../profile/store'
import { SAMPLE_RESUME, testCtx, testServices } from '../test/harness'
import { createApplication } from '../tracker/applications'
import { baseDomain, managerTitles, postingEmails, relationOf, robotsAllows } from '../contacts/discover'
import { guessEmail, inferPattern } from '../contacts/enrich'
import { OPT_OUT_LINE, unsupportedNumbers, writeDraft } from './draft'
import { addBusinessDays, contactBlock, createSequence, nextSendWindow, sendDue } from './sequence'

const sent: { to: string; subject: string; inReplyTo: string | null | undefined }[] = []
vi.mock('../mail/transport', () => ({
  sendMail: async (_ctx: unknown, _id: number, m: { to: string; subject: string; inReplyTo?: string | null }) => {
    sent.push({ to: m.to, subject: m.subject, inReplyTo: m.inReplyTo })
    return { messageId: `<m${sent.length}@example.com>` }
  },
}))

const profile = toProfile(heuristicResume(SAMPLE_RESUME))
// Tuesday 29 September 2026, 08:00 local.
const TUE = new Date(2026, 8, 29, 8, 0).getTime()

describe('finding people', () => {
  it('learns a company\'s address pattern and guesses in it', () => {
    const pattern = inferPattern([
      { name: 'Ana Silva', email: 'ana.silva@acme.com' },
      { name: 'João Costa', email: 'joao.costa@acme.com' },
    ])
    expect(pattern).toBe('first.last')
    expect(guessEmail('Maria Ferreira', 'acme.com', pattern)).toBe('maria.ferreira@acme.com')
    expect(inferPattern([{ name: 'Ana Silva', email: 'asilva@acme.com' }])).toBe('flast')
    expect(guessEmail('Cher', 'acme.com', null)).toBeNull()
  })

  it('reads roles, domains, posting emails and robots rules', () => {
    expect(relationOf('Senior Technical Recruiter', null)).toBe('recruiter')
    expect(relationOf('Engineering Manager, Payments', null)).toBe('hiring_manager')
    expect(relationOf(null, 'careers@acme.com')).toBe('generic')
    expect(managerTitles('Senior Backend Engineer')[0]).toBe('Engineering Manager')
    expect(baseDomain('careers.acme.co.uk')).toBe('acme.co.uk')
    expect(baseDomain('www.jobs.acme.com')).toBe('acme.com')
    expect(postingEmails('Questions? Email ana.silva@acme.com or no-reply@acme.com. Logo: img@2x.png')).toEqual(['ana.silva@acme.com'])
    const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /team\nAllow: /team/public\n'
    expect(robotsAllows(robots, '/about')).toBe(true)
    expect(robotsAllows(robots, '/team')).toBe(false)
    expect(robotsAllows(robots, '/team/public')).toBe(true)
  })
})

describe('drafting', () => {
  it('writes a short note from profile facts that passes the checks (offline model)', async () => {
    const ctx = testCtx()
    const s = testServices(ctx)
    const d = await writeDraft(s.ai, { profile, voice: '', purpose: 'hiring_manager', contact: { name: 'Jo Lima', title: 'Engineering Manager' }, job: { title: 'Senior Backend Engineer', company: 'Acme', description: 'Go and Kafka.' }, judgment: null, applied: true })
    expect(d.issues).toEqual([])
    expect(d.body).toMatch(/^Hi Jo,/)
    expect(d.body).toContain('Northwind Payments')
  })

  it('flags numbers that are not in the profile or posting', () => {
    expect(unsupportedNumbers('I cut costs by 28% and grew revenue 40%.', profile, '')).toEqual(['40%'])
    expect(unsupportedNumbers('Would you have time for a 20-minute call?', profile, '')).toEqual([])
  })
})

describe('sequences', () => {
  function setup() {
    const ctx = testCtx()
    ctx.now = () => TUE
    saveProfile(ctx.db, profile)
    ctx.db.run("INSERT INTO mail_accounts (provider, address, config, created_at) VALUES ('gmail', 'maya@example.com', '{}', 0)")
    const company = ctx.db.run("INSERT INTO companies (name, name_norm, domain, created_at) VALUES ('Acme', 'acme', 'acme.com', 0)").lastInsertRowid
    const app = createApplication(ctx.db, { jobId: null, groupKey: 'manual:acme:be', companyId: company, company: 'Acme', title: 'Senior Backend Engineer', huntId: null, packageId: null, status: 'applied', channel: 'ats', url: null, appliedAt: TUE, source: 'user' }, TUE)
    const contact = (name: string, email: string) => ctx.db.run("INSERT INTO contacts (company_id, company_name, name, email, relation, source, created_at) VALUES (?, 'Acme', ?, ?, 'recruiter', 'manual', 0)", [company, name, email]).lastInsertRowid
    return { ctx, app, contact, company }
  }

  it('sends in weekday morning windows and counts business days', () => {
    const fri = new Date(2026, 9, 2, 16, 0).getTime()
    expect(new Date(addBusinessDays(fri, 1)).getDay()).toBe(1)
    const at = new Date(nextSendWindow(TUE, () => 0))
    expect([at.getDay(), at.getHours()]).toEqual([2, 9])
    // Friday afternoon: the next window is Tuesday morning, not Monday.
    expect(new Date(nextSendWindow(fri, () => 0)).getDay()).toBe(2)
  })

  it('enforces per-person, per-application and per-company limits', () => {
    const { ctx, app, contact } = setup()
    const a = contact('Ana', 'ana@acme.com')
    const b = contact('Bo', 'bo@acme.com')
    const c = contact('Cy', 'cy@acme.com')
    const seq = (id: number) => createSequence(ctx, { applicationId: app, contactId: id, purpose: 'recruiter_intro', subject: 'Backend role', body: 'Hi', attachResume: false, accountId: null, schedule: false, followUpDays: [4, 7] })
    seq(a)
    expect(contactBlock(ctx, a, app)).toMatch(/last 30 days/)
    seq(b)
    expect(contactBlock(ctx, c, app)).toMatch(/per application/)
    ctx.db.run('UPDATE contacts SET do_not_contact = 1 WHERE id = ?', [c])
    expect(() => seq(c)).toThrow(/asked not to be contacted/)
  })

  it('threads follow-ups, carries the opt-out line, and stops when they reply', async () => {
    const { ctx, app, contact } = setup()
    const ana = contact('Ana Silva', 'ana@acme.com')
    const first = createSequence(ctx, { applicationId: app, contactId: ana, purpose: 'recruiter_intro', subject: 'Backend role: payments', body: 'Hi Ana,\n\nNote.\n\nMaya', attachResume: false, accountId: null, schedule: true, followUpDays: [4, 7] })
    const steps = ctx.db.all<{ step: number; body: string; status: string }>('SELECT step, body, status FROM outreach ORDER BY step')
    expect(steps.map((x) => x.status)).toEqual(['scheduled', 'scheduled', 'scheduled'])
    expect(steps[1]!.body).toContain(OPT_OUT_LINE)

    // The first window is 09:00 plus up to 150 random minutes; noon is always past it.
    ctx.now = () => TUE + 4 * 3600_000
    expect(await sendDue(ctx)).toBe(1)
    expect(sent.at(-1)).toMatchObject({ to: 'ana@acme.com', subject: 'Backend role: payments', inReplyTo: null })
    const next = ctx.db.get<{ scheduled_at: number }>('SELECT scheduled_at FROM outreach WHERE step = 1')!
    expect(new Date(next.scheduled_at).getDay()).toBe(1) // four business days after Tuesday
    // Nothing else is due yet.
    expect(await sendDue(ctx)).toBe(0)

    ctx.now = () => next.scheduled_at + 1000
    expect(await sendDue(ctx)).toBe(1)
    expect(sent.at(-1)).toMatchObject({ subject: 'Re: Backend role: payments', inReplyTo: '<m1@example.com>' })

    // A reply arrives: the last step is cancelled before it goes out.
    ctx.db.run("INSERT INTO mail_messages (account_id, message_id, from_addr, subject, date, direction, contact_id, created_at) VALUES (1, '<r@acme.com>', 'ana@acme.com', 'Re', ?, 'in', ?, 0)", [next.scheduled_at + 5000, ana])
    ctx.now = () => next.scheduled_at + 30 * 86_400_000
    expect(await sendDue(ctx)).toBe(0)
    expect(ctx.db.get<{ status: string; error: string }>('SELECT status, error FROM outreach WHERE step = 2')).toEqual({ status: 'cancelled', error: 'They replied.' })
    expect(ctx.db.get<{ type: string }>("SELECT type FROM events WHERE type = 'outreach_sent' LIMIT 1")).toBeDefined()
    expect(first).toBeGreaterThan(0)
  })

  it('cancels a sequence when the application is rejected', async () => {
    const { ctx, app, contact } = setup()
    createSequence(ctx, { applicationId: app, contactId: contact('Ana', 'ana@acme.com'), purpose: 'recruiter_intro', subject: 'x', body: 'Hi', attachResume: false, accountId: null, schedule: true, followUpDays: [4] })
    ctx.db.run("UPDATE applications SET status = 'rejected'")
    ctx.now = () => TUE + 86_400_000
    const before = sent.length
    await sendDue(ctx)
    expect(sent.length).toBe(before)
    expect(ctx.db.all<{ status: string }>('SELECT status FROM outreach').map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
  })
})
