import { HuntConfigSchema, type Profile } from '../../shared/domain'
import { HttpError } from '../core/http'
import type { Http } from '../core/http'
import type { Ctx } from '../engine'
import { ingest, upsertCompany } from '../jobs/ingest'
import { saveHunt } from '../match/hunts'
import { scoreNewJobs } from '../match/pipeline'
import { runPrepare } from '../packages/handlers'
import { approvePackage } from '../packages/store'
import { heuristicResume, toProfile } from '../profile/extract'
import { loadProfile, saveProfile } from '../profile/store'
import { storiesPrompt } from '../prep/prompts'
import type { Services } from '../services'
import { addEvent, setStatus } from '../tracker/applications'
import { createSequence } from '../outreach/sequence'
import { processMessage, type ParsedMail } from '../mail/process'
import type { RawPosting } from '../sources/types'

/**
 * Sample workspace for demo mode and screenshots. Every company, person and posting here is fictional.
 * The data goes through the real pipeline (ingest, scoring, preparation, mail processing) so the
 * screens show what the product actually produces. Runs offline with the built-in sample model.
 */
export const DEMO_RESUME = `Maya Okafor
Senior Backend Engineer
Lisbon, Portugal
maya.okafor@example.com | +351 912 345 678 | linkedin.com/in/maya-okafor-example | github.com/maya-okafor-example

SUMMARY
Backend engineer with eight years building payment and data systems.

EXPERIENCE
Senior Backend Engineer, Northwind Payments — Mar 2021 – Present
- Cut settlement batch time from 4 hours to 35 minutes by moving jobs to event-driven workers in Go
- Led a team of 5 engineers through a PostgreSQL 16 upgrade with zero downtime
- Designed the idempotency layer for the card API, handling 1,200 requests per second at peak
- Introduced contract tests between 14 services, reducing integration incidents by 60%
Backend Engineer, Tidewater Analytics — Jun 2017 – Feb 2021
- Built ingestion pipelines in Python and Kafka processing 40 million events per day
- Reduced AWS costs by 28% by rightsizing EC2 fleets and adding S3 lifecycle rules
- Mentored 3 junior engineers through their first on-call rotations

EDUCATION
University of Porto — BSc Computer Science, 2013 – 2017

SKILLS
Go, Python, PostgreSQL, Kafka, AWS, Kubernetes, Terraform, gRPC, Redis, Docker
`

type Spec = { company: string; board: string; ats: 'greenhouse' | 'lever' | 'ashby'; title: string; location: string; remote?: 'remote' | 'hybrid'; salary?: [number, number, string]; days: number; stack: string[]; extra?: string }

const JOBS: Spec[] = [
  { company: 'Cobaltwave Payments', board: 'cobaltwave', ats: 'greenhouse', title: 'Senior Backend Engineer, Payments Core', location: 'Lisbon, Portugal', remote: 'hybrid', salary: [80_000, 98_000, 'EUR'], days: 1, stack: ['Go', 'PostgreSQL', 'Kafka', 'Kubernetes'] },
  { company: 'Harborline Freight', board: 'harborline', ats: 'lever', title: 'Backend Engineer (Go)', location: 'Remote, Europe', remote: 'remote', salary: [70_000, 85_000, 'EUR'], days: 2, stack: ['Go', 'gRPC', 'PostgreSQL', 'AWS'] },
  { company: 'Ferncliff Analytics', board: 'ferncliff', ats: 'ashby', title: 'Senior Data Platform Engineer', location: 'Porto, Portugal', remote: 'hybrid', salary: [75_000, 90_000, 'EUR'], days: 3, stack: ['Python', 'Kafka', 'Terraform', 'AWS'] },
  { company: 'Slatebridge Software', board: 'slatebridge', ats: 'greenhouse', title: 'Platform Engineer', location: 'Remote, Portugal', remote: 'remote', days: 2, stack: ['Kubernetes', 'Terraform', 'Go', 'AWS'] },
  { company: 'Kestrel Grid', board: 'kestrelgrid', ats: 'lever', title: 'Senior Software Engineer, Billing', location: 'Amsterdam, Netherlands', remote: 'hybrid', salary: [85_000, 105_000, 'EUR'], days: 4, stack: ['Go', 'PostgreSQL', 'Redis'] },
  { company: 'Orchard Row Health', board: 'orchardrow', ats: 'ashby', title: 'Backend Engineer, Integrations', location: 'Remote, Europe', remote: 'remote', salary: [65_000, 80_000, 'EUR'], days: 5, stack: ['Python', 'PostgreSQL', 'AWS'] },
  { company: 'Palisade Maps', board: 'palisademaps', ats: 'greenhouse', title: 'Staff Backend Engineer', location: 'Berlin, Germany', salary: [110_000, 130_000, 'EUR'], days: 6, stack: ['Go', 'Kubernetes', 'PostgreSQL'], extra: '10+ years of experience and prior staff-level scope across several teams.' },
  { company: 'Quillfeather Labs', board: 'quillfeather', ats: 'lever', title: 'Senior Backend Engineer', location: 'Lisbon, Portugal', remote: 'hybrid', days: 7, stack: ['Go', 'Kafka', 'Docker'] },
  { company: 'Mossgate Energy', board: 'mossgate', ats: 'ashby', title: 'Software Engineer, Grid Data', location: 'Madrid, Spain', remote: 'hybrid', salary: [55_000, 68_000, 'EUR'], days: 8, stack: ['Python', 'Kafka', 'Terraform'] },
  { company: 'Blue Heron Insurance', board: 'blueheron', ats: 'greenhouse', title: 'Senior Backend Engineer, Claims', location: 'London, United Kingdom', remote: 'hybrid', salary: [85_000, 100_000, 'GBP'], days: 9, stack: ['Go', 'PostgreSQL', 'AWS'], extra: 'You must already have the right to work in the UK; we do not sponsor visas for this role.' },
  { company: 'Lanternfish Security', board: 'lanternfish', ats: 'lever', title: 'Backend Engineer, Detection', location: 'Remote, Europe', remote: 'remote', days: 10, stack: ['Rust', 'Kafka', 'ClickHouse'] },
  { company: 'Tessellate Retail', board: 'tessellate', ats: 'ashby', title: 'Frontend Engineer', location: 'Lisbon, Portugal', days: 3, stack: ['React', 'TypeScript', 'GraphQL'] },
  { company: 'Northgate Staffing Partners', board: 'northgatestaff', ats: 'greenhouse', title: 'Backend Engineer (contract, client in Lisbon)', location: 'Lisbon, Portugal', days: 2, stack: ['Java', 'Spring'], extra: 'We are a staffing agency recruiting on behalf of our client.' },
  { company: 'Driftwood Media', board: 'driftwood', ats: 'lever', title: 'Senior Platform Engineer', location: 'Remote, Europe', remote: 'remote', salary: [72_000, 88_000, 'EUR'], days: 12, stack: ['Kubernetes', 'Terraform', 'Go', 'Python'] },
  { company: 'Juniper Ledger', board: 'juniperledger', ats: 'greenhouse', title: 'Backend Engineer, Ledger', location: 'Dublin, Ireland', remote: 'hybrid', salary: [80_000, 95_000, 'EUR'], days: 14, stack: ['Go', 'PostgreSQL', 'Kafka'] },
  { company: 'Wren Robotics', board: 'wrenrobotics', ats: 'ashby', title: 'Embedded Software Engineer', location: 'Munich, Germany', days: 5, stack: ['C++', 'Embedded Linux'] },
]

function describe(j: Spec): string {
  const [a, b, c, d] = j.stack
  return [
    `<p>${j.company} is hiring a ${j.title} to work on the systems behind our product.</p>`,
    '<h3>What you will do</h3><ul>',
    `<li>Design and run services in ${a}${b ? ` backed by ${b}` : ''}.</li>`,
    `<li>Own reliability for the services you build, including on-call one week in six.</li>`,
    c ? `<li>Work with ${c}${d ? ` and ${d}` : ''} every day.</li>` : '',
    '</ul><h3>Requirements</h3><ul>',
    `<li>5+ years building backend services in production.</li>`,
    `<li>Strong ${a} experience.</li>`,
    b ? `<li>Experience with ${b} at scale.</li>` : '',
    c ? `<li>Hands-on ${c}.</li>` : '',
    j.extra ? `<li>${j.extra}</li>` : '',
    '</ul><h3>Nice to have</h3><ul>',
    d ? `<li>${d}.</li>` : '<li>Payments or fintech background.</li>',
    '</ul>',
    j.salary ? `<p>Salary: ${j.salary[2] === 'GBP' ? '£' : '€'}${j.salary[0].toLocaleString('en-GB')} - ${j.salary[2] === 'GBP' ? '£' : '€'}${j.salary[1].toLocaleString('en-GB')} per year.</p>` : '',
  ].join('')
}

const url = (j: Spec, id: string) =>
  j.ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${j.board}/jobs/${id}` : j.ats === 'lever' ? `https://jobs.lever.co/${j.board}/${id}` : `https://jobs.ashbyhq.com/${j.board}/${id}`

/** No network in the sample workspace: forms come from the Lever standard fields or the cache. */
const offlineHttp = {
  getJson: async (u: string) => {
    throw new HttpError(404, u, 'offline sample workspace')
  },
  getText: async (u: string) => {
    throw new HttpError(404, u, 'offline sample workspace')
  },
} as unknown as Http

export async function seedDemo(ctx: Ctx, s: Services): Promise<void> {
  const { db } = ctx
  if (db.get('SELECT 1 FROM profile')) return
  const DAY = 86_400_000
  const now = ctx.now()
  const realHttp = ctx.http
  ctx.http = offlineHttp
  // Region first: it picks the documents' page size.
  ctx.settings.update({ region: 'EU' })
  try {
    const base = toProfile(heuristicResume(DEMO_RESUME))
    const profile: Profile = {
      ...base,
      languages: [
        { name: 'English', fluency: 'Fluent' },
        { name: 'Portuguese', fluency: 'Native' },
      ],
      jobSearch: {
        ...base.jobSearch,
        workAuthorization: [
          { country: 'PT', authorized: true, needsSponsorship: false },
          { country: 'NL', authorized: true, needsSponsorship: false },
          { country: 'DE', authorized: true, needsSponsorship: false },
          { country: 'ES', authorized: true, needsSponsorship: false },
          { country: 'IE', authorized: true, needsSponsorship: false },
          { country: 'GB', authorized: false, needsSponsorship: true },
          { country: 'US', authorized: false, needsSponsorship: true },
        ],
        noticePeriod: '1 month',
        expectedCompensation: { amount: 85_000, currency: 'EUR', period: 'year' },
        relocation: 'no',
        over18: true,
        driversLicense: true,
      },
    }
    saveProfile(db, profile, DEMO_RESUME, now - 30 * DAY)

    const mock = s.providers.save({ kind: 'mock', label: 'Sample model', fields: {} })
    for (const role of ['fast', 'writer', 'agent', 'review']) db.run('INSERT OR REPLACE INTO model_roles (role, provider_id, model_id) VALUES (?, ?, ?)', [role, mock.id, 'mock-large'])

    const hunt = saveHunt(
      db,
      {
        name: 'Backend, Lisbon or remote',
        mode: 'review',
        active: true,
        baseResumeId: null,
        config: HuntConfigSchema.parse({
          titles: ['Backend Engineer', 'Platform Engineer', 'Software Engineer'],
          places: [{ label: 'Lisbon', city: 'Lisbon', country: 'PT', lat: 38.72, lon: -9.14, radiusKm: 40 }],
          workplace: { onsite: true, hybrid: true, remote: true },
          remoteCountries: ['PT', 'ES', 'NL', 'DE', 'IE'],
          salaryFloor: { amount: 65_000, currency: 'EUR', period: 'year' },
          template: 'modern',
          outreach: { enabled: true, autopilot: false, dailyCap: 5, followUpDays: [4, 7] },
        }),
      },
      now - 30 * DAY,
    )

    // Postings, grouped by fictional board. Source rows are disabled so nothing is polled.
    const byBoard = new Map<string, Spec[]>()
    for (const j of JOBS) byBoard.set(`${j.ats}:${j.board}`, [...(byBoard.get(`${j.ats}:${j.board}`) ?? []), j])
    for (const [key, specs] of byBoard) {
      const [ats, board] = key.split(':') as [Spec['ats'], string]
      const srcId = db.run("INSERT INTO sources (kind, key, label, config, origin, enabled, created_at) VALUES (?, ?, ?, '{}', 'user', 0, ?)", [ats, board, specs[0]!.company, now - 30 * DAY]).lastInsertRowid
      const postings: RawPosting[] = specs.map((j, i) => {
        const id = ats === 'greenhouse' ? String(4_100_000 + i + board.length * 97) : `${board}-${i}-0a1b2c3d`
        return { externalId: id, title: j.title, company: j.company, url: url(j, id), applyUrl: url(j, id), locationText: j.location, remoteHint: j.remote, descriptionHtml: describe(j), postedAt: now - j.days * DAY, meta: ats === 'greenhouse' ? { token: board } : {} }
      })
      ingest(db, { id: srcId, kind: ats }, { complete: false, postings }, now - 1000)
      db.run('UPDATE companies SET domain = ? WHERE name = ?', [`${board}.example`, specs[0]!.company])
    }
    await scoreNewJobs(ctx, s, null)
    ctx.queue.cancel({ type: 'packages.prepare' })

    // Packages for the best matches, prepared by the real pipeline.
    const top = db.all<{ job_id: number }>("SELECT job_id FROM job_scores WHERE hunt_id = ? AND stage = 'judged' AND score >= ? ORDER BY score DESC LIMIT 7", [hunt.id, hunt.config.queueThreshold])
    const pkgs: number[] = []
    for (const t of top) pkgs.push(await runPrepare(ctx, s, t.job_id, hunt.id).catch(() => 0))

    // History: applications over the last eight weeks, with the outcomes a real search has.
    const past = [
      { company: 'Alderbrook Bank', title: 'Senior Backend Engineer', weeks: 8, path: ['screening', 'interviewing', 'rejected'] },
      { company: 'Cinderpath Games', title: 'Backend Engineer', weeks: 7, path: ['ghosted'] },
      { company: 'Seabright Travel', title: 'Platform Engineer', weeks: 7, path: ['rejected'] },
      { company: 'Granary Foods', title: 'Backend Engineer', weeks: 6, path: [] },
      { company: 'Halcyon Clinics', title: 'Senior Software Engineer', weeks: 6, path: ['screening'] },
      { company: 'Ironwood Logistics', title: 'Backend Engineer, Routing', weeks: 5, path: ['screening', 'interviewing', 'offer'] },
      { company: 'Pebblecreek Studio', title: 'Software Engineer', weeks: 5, path: ['rejected'] },
      { company: 'Redfern Telecom', title: 'Senior Backend Engineer', weeks: 4, path: [] },
      { company: 'Summit Lane Capital', title: 'Backend Engineer', weeks: 4, path: ['screening', 'rejected'] },
      { company: 'Vellum Docs', title: 'Platform Engineer', weeks: 3, path: ['screening', 'interviewing'] },
      { company: 'Westerly Wind', title: 'Software Engineer, Data', weeks: 3, path: [] },
      { company: 'Yarrow Health', title: 'Backend Engineer', weeks: 2, path: ['rejected'] },
      { company: 'Zephyr Mobility', title: 'Senior Backend Engineer', weeks: 2, path: [] },
      { company: 'Amberline Energy', title: 'Backend Engineer', weeks: 1, path: [] },
    ]
    const appIds: Record<string, number> = {}
    for (const [i, p] of past.entries()) {
      const at = now - p.weeks * 7 * DAY + i * 3600_000
      const slug = p.company.toLowerCase().replace(/\W+/g, '')
      const companyId = upsertCompany(db, p.company, { domain: `${slug}.example`, now: at })
      const id = db.run(
        "INSERT INTO applications (group_key, company_id, company_name, title, hunt_id, status, channel, method, url, applied_at, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, 'applied', 'ats', ?, ?, ?, ?, ?)",
        [`manual:${slug}:${p.title}`, companyId, p.company, p.title, hunt.id, i % 3 === 0 ? 'assisted' : 'agent', `https://jobs.lever.co/${slug}/x${i}`, at, at, at],
      ).lastInsertRowid
      addEvent(db, id, 'created', 'app', { status: 'applied' }, at)
      addEvent(db, id, 'applied', 'run', {}, at)
      p.path.forEach((st, k) => setStatus(db, id, st as never, st === 'ghosted' ? 'rule' : 'mail', {}, at + (k + 1) * 5 * DAY))
      appIds[p.company] = id
    }

    // One prepared package approved and waiting after a dry run; one run waiting on a question.
    const ready = pkgs.filter(Boolean)
    if (ready[0]) {
      try {
        const appId = approvePackage(ctx, ready[0], 'user')
        ctx.queue.cancel({ dedupeKey: `apply:${appId}` })
        db.run("INSERT INTO runs (application_id, package_id, adapter, mode, status, question, steps, started_at, ended_at) VALUES (?, ?, 'greenhouse', 'dry_run', 'dry_run_done', ?, ?, ?, ?)", [
          appId,
          ready[0],
          'Dry run finished. Check what was filled, then send it for real.',
          JSON.stringify([
            { at: now - 3600_000, kind: 'navigate', text: 'Opened the application form' },
            { at: now - 3590_000, kind: 'fill', text: 'First Name: Maya' },
            { at: now - 3585_000, kind: 'fill', text: 'Last Name: Okafor' },
            { at: now - 3580_000, kind: 'upload', text: 'Resume/CV: Maya_Okafor_Resume.pdf' },
            { at: now - 3570_000, kind: 'fill', text: 'Are you legally authorized to work in Portugal?: Yes' },
            { at: now - 3560_000, kind: 'evidence', text: 'Saved before-submit.jpg' },
            { at: now - 3555_000, kind: 'info', text: 'Dry run: stopped before the final click.' },
          ]),
          now - 3600_000,
          now - 3550_000,
        ])
        db.run("UPDATE applications SET status = 'needs_user' WHERE id = ?", [appId])
      } catch {
        /* sample data only */
      }
    }
    if (ready[1]) {
      try {
        const appId = approvePackage(ctx, ready[1], 'user')
        ctx.queue.cancel({ dedupeKey: `apply:${appId}` })
        const company = db.get<{ company_name: string }>('SELECT company_name FROM applications WHERE id = ?', [appId])!.company_name
        const q = `${company} asks: Are you able to work from our office two days a week? (Yes, No). No saved answer.`
        const runId = db.run("INSERT INTO runs (application_id, package_id, adapter, mode, status, question, steps, started_at) VALUES (?, ?, 'lever', 'submit', 'paused', ?, '[]', ?)", [appId, ready[1], q, now - 2 * 3600_000]).lastInsertRowid
        db.run("UPDATE applications SET status = 'needs_user' WHERE id = ?", [appId])
        addEvent(db, appId, 'needs_user', 'run', { runId, question: q, fieldName: 'cards[office][field0]', label: 'Are you able to work from our office two days a week?' }, now - 2 * 3600_000)
      } catch {
        /* sample data only */
      }
    }

    // Mail: confirmations, a rejection, an interview invite with a calendar file, one message to sort.
    const account = db.run("INSERT INTO mail_accounts (provider, address, display_name, config, status, last_sync_at, created_at) VALUES ('gmail', 'maya.okafor@example.com', 'Maya Okafor', '{}', 'ok', ?, ?)", [now - 600_000, now - 30 * DAY]).lastInsertRowid
    const mail = (o: Partial<ParsedMail>): ParsedMail => ({ from: 'no-reply@hire.lever.co', fromName: '', to: ['maya.okafor@example.com'], subject: '', text: '', date: now, inReplyTo: null, headers: {}, messageId: `<demo-${Math.random().toString(36).slice(2)}@example.com>`, references: [], direction: 'in', folder: 'INBOX', uid: null, ics: [], ...o })
    const start = new Date(now + 2 * DAY)
    start.setHours(15, 0, 0, 0)
    const ics = (d: Date) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}\nDTEND:${new Date(d.getTime() + 3600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}\nSUMMARY:Technical interview - Vellum Docs\nLOCATION:https://meet.google.com/vel-lumd-ocs\nEND:VEVENT\nEND:VCALENDAR`
    await processMessage(ctx, null, null, account, mail({ from: 'talent@vellumdocs.example', fromName: 'Priya Raman', subject: 'Technical interview for Platform Engineer', text: 'Hi Maya, thanks for the chat last week. The invite for your technical interview with the platform team is attached. It runs an hour.', date: now - 5 * 3600_000, ics: [ics(start)] }))
    await processMessage(ctx, null, null, account, mail({ fromName: 'Yarrow Health', subject: 'Your application to Yarrow Health', text: 'Thank you for your interest in the Backend Engineer role. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs.', date: now - 26 * 3600_000 }))
    await processMessage(ctx, null, null, account, mail({ from: 'jobs@granaryfoods.example', fromName: 'Granary Foods Talent', subject: 'Next steps', text: 'We would like to schedule a phone screen for one of our engineering roles. Please share your availability for next week.', date: now - 3 * 3600_000 }))

    // Contacts and outreach: one draft waiting in the Outbox, one sequence already sent.
    const contact = (name: string, title: string, email: string, company: string) =>
      db.run("INSERT INTO contacts (company_id, company_name, name, title, relation, email, email_status, source, confidence, created_at) VALUES ((SELECT id FROM companies WHERE name = ?), ?, ?, ?, ?, ?, 'verified', 'hunter', 0.9, ?)", [
        company,
        company,
        name,
        title,
        /recruit|talent/i.test(title) ? 'recruiter' : 'hiring_manager',
        email,
        now - 3 * DAY,
      ]).lastInsertRowid
    const firstPkgApp = db.get<{ id: number; company_name: string }>("SELECT id, company_name FROM applications WHERE package_id IS NOT NULL ORDER BY id LIMIT 1")
    if (firstPkgApp) {
      const c = contact('Tomás Reis', 'Engineering Manager, Payments', `tomas.reis@${firstPkgApp.company_name.toLowerCase().replace(/\W+/g, '')}.example`, firstPkgApp.company_name)
      createSequence(ctx, {
        applicationId: firstPkgApp.id,
        contactId: c,
        purpose: 'hiring_manager',
        subject: 'Senior backend role: payments idempotency work',
        body: `Hi Tomás,\n\nI applied for the Senior Backend Engineer role on your team. At Northwind Payments I designed the idempotency layer for our card API, which handles 1,200 requests per second at peak, and led the PostgreSQL 16 upgrade with zero downtime.\n\nWould you be open to a short call about the team's plans? My resume is attached.\n\nMaya`,
        attachResume: true,
        accountId: account,
        schedule: false,
        followUpDays: [4, 7],
      })
    }
    const alder = contact('Jonah Whitfield', 'Senior Technical Recruiter', 'jonah.whitfield@halcyonclinics.example', 'Halcyon Clinics')
    db.run(
      "INSERT INTO outreach (application_id, contact_id, channel, step, purpose, subject, body, status, sent_at, message_id, thread_key, account_id, created_at) VALUES (?, ?, 'email', 0, 'recruiter_intro', 'Senior Software Engineer role: payments background', ?, 'sent', ?, '<demo-sent-1@example.com>', 'demo-1', ?, ?)",
      [appIds['Halcyon Clinics'], alder, 'Hi Jonah,\n\nI applied for the Senior Software Engineer role. I have led payment and data platform work for eight years.\n\nAre you the right person to talk to about it?\n\nMaya', now - 38 * DAY, account, now - 38 * DAY],
    )

    // An upcoming recruiter screen, an offer, and stories drafted from the profile.
    const tomorrow = new Date(now + DAY)
    tomorrow.setHours(10, 30, 0, 0)
    db.run("INSERT INTO interviews (application_id, starts_at, ends_at, kind, link, interviewers, notes, source, created_at) VALUES (?, ?, ?, 'recruiter', 'https://meet.google.com/abc-defg-hij', '[\"Ana Duarte\"]', '', 'user', ?)", [
      appIds['Halcyon Clinics'],
      tomorrow.getTime(),
      tomorrow.getTime() + 30 * 60_000,
      now,
    ])
    // Prep for that screen, written by the same handler the Prep screen uses.
    await ctx.router.handle('prep.generate', { applicationId: appIds['Halcyon Clinics'], part: 'questions', kind: 'recruiter' })
    db.run('INSERT INTO offers (application_id, company, data, created_at) VALUES (?, ?, ?, ?)', [
      appIds['Ironwood Logistics'],
      'Ironwood Logistics',
      JSON.stringify({ company: 'Ironwood Logistics', title: 'Backend Engineer, Routing', currency: 'EUR', base: 82_000, bonusPct: 8, signOn: 5_000, equityValue: 24_000, vestingYears: 4, cliffMonths: 12, benefits: 'Health insurance, 25 days leave, remote stipend', location: 'Lisbon (hybrid)', deadline: new Date(now + 6 * DAY).toISOString().slice(0, 10) }),
      now - 2 * DAY,
    ])
    const stories = await s.ai.structured(storiesPrompt, { profile: loadProfile(db).profile }, { task: 'Draft stories' })
    for (const st of stories.stories) db.run('INSERT INTO stories (title, situation, task, action, result, fact_ids, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [st.title, st.situation, st.task, st.action, st.result, JSON.stringify(st.factIds), JSON.stringify(st.tags), now, now])

    // Sample spend history (clearly a sample workspace), so the spend views have something to show.
    for (let d = 0; d < 56; d++) {
      const calls = 20 + ((d * 7) % 23)
      db.run("INSERT INTO ai_ledger (at, provider_kind, model_id, role, task, input_tokens, output_tokens, cost, ok) VALUES (?, 'anthropic', 'claude-haiku-4-5', 'fast', 'Score job', ?, ?, ?, 1)", [now - d * DAY, calls * 3000, calls * 400, calls * 0.005])
    }

    ctx.settings.update({ onboarded: true, automation: { trustRampRemaining: 1 } })
    ctx.bus.changed('jobs', 'packages', 'applications', 'mail', 'outreach', 'profile', 'hunts', 'documents', 'prep', 'usage')
  } finally {
    ctx.http = realHttp
  }
}
