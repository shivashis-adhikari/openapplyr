import { describe, expect, it } from 'vitest'
import { testCtx, testServices } from '../test/harness'
import { createApplication } from '../tracker/applications'
import { classifyByRules, companyHint, extractCode, parseIcs, prefilter, returnDate } from './classify'
import { type ParsedMail, processMessage, statusFor } from './process'
import { composeMail, sendMail } from './transport'

const NOW = Date.UTC(2026, 8, 28, 12)
const mail = (over: Partial<ParsedMail>): ParsedMail => ({
  from: 'no-reply@us.greenhouse-mail.io',
  fromName: 'Acme Recruiting',
  to: ['maya@example.com'],
  subject: '',
  text: '',
  date: NOW,
  inReplyTo: null,
  headers: {},
  messageId: `<${Math.random()}@x>`,
  references: [],
  direction: 'in',
  folder: 'INBOX',
  uid: 1,
  ics: [],
  ...over,
})

describe('rules', () => {
  it('reads the common candidate emails', () => {
    const c = (subject: string, text = '') => classifyByRules(mail({ subject, text }), NOW)?.category ?? null
    expect(c('Thank you for applying to Acme')).toBe('application_received')
    expect(c('Thank you for your interest in Acme', 'Unfortunately, we have decided to move forward with other candidates.')).toBe('rejection')
    expect(c('Your application to Acme', 'We would love to schedule a phone screen. Please share your availability.')).toBe('interview_request')
    expect(c('Acme coding challenge', 'Please complete the HackerRank assessment within 5 days.')).toBe('assessment')
    expect(c('Offer letter', 'We are pleased to extend an offer of employment.')).toBe('offer')
    expect(c('Your verification code', 'Your code is 482913.')).toBe('verification_code')
    expect(c('Lunch on Friday?', 'See you there.')).toBeNull()
  })

  it('pulls out codes, return dates and company names', () => {
    expect(extractCode('Use this verification code: 552 in the next... no. Your code is 482913 and expires soon.')).toBe('482913')
    expect(new Date(returnDate('I am out of the office and back on 14 October.', NOW)!).getDate()).toBe(14)
    expect(new Date(returnDate('Returning Oct 3.', NOW)!).getFullYear()).toBe(2026)
    // A date already past this year means next year.
    expect(new Date(returnDate('Back on Sep 3.', NOW)!).getFullYear()).toBe(2027)
    expect(companyHint('Thank you for applying to Tidewater Analytics', '')).toBe('Tidewater Analytics')
    expect(companyHint('Your application', 'Thanks for your application for the Senior Backend Engineer role at Northwind Payments.')).toBe('Northwind Payments')
  })

  it('keeps only mail that could be about the search', () => {
    const known = { domains: new Set(['acme.com']), contacts: new Set(['ana@globex.com']), sentIds: new Set(['<sent-1@x>']) }
    expect(prefilter({ from: 'news@shop.example', subject: 'Weekend sale', inReplyTo: null }, known)).toBe(false)
    expect(prefilter({ from: 'no-reply@hire.lever.co', subject: 'Hello', inReplyTo: null }, known)).toBe(true)
    expect(prefilter({ from: 'jo@eng.acme.com', subject: 'Hi', inReplyTo: null }, known)).toBe(true)
    expect(prefilter({ from: 'ana@globex.com', subject: 'Hi', inReplyTo: null }, known)).toBe(true)
    expect(prefilter({ from: 'x@y.z', subject: 'Re: hello', inReplyTo: '<sent-1@x>' }, known)).toBe(true)
    expect(prefilter({ from: 'x@y.z', subject: 'Interview availability', inReplyTo: null }, known)).toBe(true)
  })

  it('reads a calendar invite', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261002T150000Z\r\nDTEND:20261002T154500Z\r\nSUMMARY:Technical interview - Acme\r\nLOCATION:https://acme.zoom.us/j/123\r\nDESCRIPTION:Join at https://acme.zoom.us/j/123\\nSee you\r\nEND:VEVENT\r\nEND:VCALENDAR'
    expect(parseIcs(ics)).toMatchObject({ start: Date.UTC(2026, 9, 2, 15), end: Date.UTC(2026, 9, 2, 15, 45), link: 'https://acme.zoom.us/j/123', summary: 'Technical interview - Acme' })
  })

  it('maps categories to status moves', () => {
    expect(statusFor('interview_request', 'applied')).toBe('screening')
    expect(statusFor('interview_request', 'screening')).toBe('interviewing')
    expect(statusFor('application_received', 'applied')).toBeNull()
    expect(statusFor('application_received', 'applied_unverified')).toBe('applied')
  })
})

describe('processing', () => {
  function setup() {
    const ctx = testCtx()
    ctx.now = () => NOW
    const s = testServices(ctx)
    const account = ctx.db.run("INSERT INTO mail_accounts (provider, address, config, created_at) VALUES ('gmail', 'maya@example.com', '{}', 0)").lastInsertRowid
    const acme = ctx.db.run("INSERT INTO companies (name, name_norm, domain, created_at) VALUES ('Acme', 'acme', 'acme.com', 0)").lastInsertRowid
    const app = (company: string, title: string, companyId: number | null, status: 'applied' | 'applied_unverified' = 'applied') =>
      createApplication(ctx.db, { jobId: null, groupKey: `manual:${company}:${title}`, companyId, company, title, huntId: null, packageId: null, status, channel: 'ats', url: null, appliedAt: NOW - 5 * 86_400_000, source: 'app' }, NOW - 5 * 86_400_000)
    return { ctx, s, account, acme, app }
  }
  const status = (ctx: ReturnType<typeof testCtx>, id: number) => ctx.db.get<{ status: string }>('SELECT status FROM applications WHERE id = ?', [id])!.status

  it('confirms an unverified application from the ATS email, and ignores unrelated mail', async () => {
    const { ctx, s, account, acme, app } = setup()
    const id = app('Acme', 'Senior Backend Engineer', acme, 'applied_unverified')
    await processMessage(ctx, s, null, account, mail({ subject: 'Thank you for applying to Acme', text: 'We received your application for Senior Backend Engineer.' }))
    expect(status(ctx, id)).toBe('applied')
    expect(await processMessage(ctx, s, null, account, mail({ from: 'deals@shop.example', subject: 'Weekend sale' }))).toBeNull()
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_messages')!.n).toBe(1)
  })

  it('moves an application to rejected and stops follow-ups', async () => {
    const { ctx, s, account, acme, app } = setup()
    const id = app('Acme', 'Senior Backend Engineer', acme)
    const contact = ctx.db.run("INSERT INTO contacts (company_id, company_name, name, email, source, created_at) VALUES (?, 'Acme', 'Jo', 'jo@acme.com', 'posting', 0)", [acme]).lastInsertRowid
    ctx.db.run("INSERT INTO outreach (application_id, contact_id, channel, purpose, body, status, scheduled_at, created_at) VALUES (?, ?, 'email', 'follow_up', 'x', 'scheduled', ?, 0)", [id, contact, NOW + 86_400_000])
    await processMessage(ctx, s, null, account, mail({ from: 'jo@acme.com', fromName: 'Jo', subject: 'Your application', text: 'Thanks for your time. Unfortunately we will not be moving forward with your application for Senior Backend Engineer.' }))
    expect(status(ctx, id)).toBe('rejected')
    expect(ctx.db.get<{ status: string }>('SELECT status FROM outreach')!.status).toBe('cancelled')
  })

  it('asks the user when two applications could match', async () => {
    const { ctx, s, account, app } = setup()
    app('Globex', 'Backend Engineer', null)
    app('Globex', 'Data Engineer', null)
    const row = await processMessage(ctx, s, null, account, mail({ from: 'talent@globex.io', subject: 'Interview with Globex', text: 'We would like to schedule an interview. Please share your availability.' }))
    const m = ctx.db.get<{ needs_review: number; application_id: number | null; classification: string }>('SELECT needs_review, application_id, classification FROM mail_messages WHERE id = ?', [row])!
    expect(m.application_id).toBeNull()
    expect(m.needs_review).toBe(1)
    expect(JSON.parse(m.classification).suggestions).toHaveLength(2)
  })

  it('creates an interview from an invite and records an opt-out permanently', async () => {
    const { ctx, s, account, acme, app } = setup()
    const id = app('Acme', 'Senior Backend Engineer', acme)
    ctx.db.run("INSERT INTO contacts (company_id, company_name, name, email, source, created_at) VALUES (?, 'Acme', 'Jo', 'jo@acme.com', 'posting', 0)", [acme])
    const ics = 'BEGIN:VEVENT\nDTSTART:20261002T150000Z\nDTEND:20261002T160000Z\nSUMMARY:Technical interview\nLOCATION:https://meet.google.com/abc-defg-hij\nEND:VEVENT'
    await processMessage(ctx, s, null, account, mail({ from: 'jo@acme.com', subject: 'Interview for Senior Backend Engineer', text: 'Invite attached for your interview.', ics: [ics] }))
    expect(ctx.db.get('SELECT kind, link FROM interviews WHERE application_id = ?', [id])).toEqual({ kind: 'technical', link: 'https://meet.google.com/abc-defg-hij' })
    await processMessage(ctx, s, null, account, mail({ from: 'jo@acme.com', subject: 'Re: hello', text: 'Please remove me from your list.' }))
    expect(ctx.db.get<{ do_not_contact: number }>('SELECT do_not_contact FROM contacts')!.do_not_contact).toBe(1)
  })
})

describe('sending', () => {
  it('threads follow-ups and sends plain text without tracking', async () => {
    const { raw, messageId } = await composeMail({ address: 'maya@example.com', name: 'Maya Okafor' }, { to: 'jo@acme.com', subject: 'Re: Backend role', text: 'Hi Jo,\n\nFollowing up.', inReplyTo: '<first@example.com>', references: ['<root@acme.com>'] })
    const text = raw.toString('utf8')
    expect(messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(text).toContain(`Message-ID: ${messageId}`)
    expect(text).toContain('In-Reply-To: <first@example.com>')
    expect(text).toMatch(/References: <root@acme\.com> <first@example\.com>/)
    expect(text).toMatch(/Content-Type: text\/plain/)
    expect(text).not.toMatch(/<img|text\/html/)
  })
})

describe('sample workspace', () => {
  it('sends no email', async () => {
    await expect(sendMail(testCtx(), 1, { to: 'a@b.example', subject: 'x', text: 'x' })).rejects.toThrow(/sample workspace/)
  })
})
