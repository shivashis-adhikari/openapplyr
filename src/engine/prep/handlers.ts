import type { Chat, MockSession, OfferRow, Prep, Story } from '../../shared/api/prep'
import type { Interview } from '../../shared/domain'
import { json } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { type ChatMessage, assistantTurn } from '../assistant/assistant'
import { careerExplorer, offerTotals, type Offer, skillsGap } from '../career/insights'
import { baseDomain, companyPages } from '../contacts/discover'
import { styleCheck } from '../docs/styleguard'
import { listHunts } from '../match/hunts'
import { unsupportedNumbers } from '../outreach/draft'
import { factIds } from '../profile/digest'
import { loadProfile, loadVoice } from '../profile/store'
import type { Services } from '../services'
import { isPlatformHost } from '../sources/detect'
import { addEvent } from '../tracker/applications'
import { type InterviewKind, type MockMessage, briefPrompt, linkedinPostPrompt, mockPrompt, negotiationPrompt, questionsPrompt, sourcedOnly, storiesPrompt } from './prompts'

type InterviewRow = { id: number; application_id: number | null; starts_at: number | null; ends_at: number | null; kind: Interview['kind']; location: string | null; link: string | null; interviewers: string; notes: string; company_name: string | null; title: string | null }
const interview = (r: InterviewRow): Interview => ({
  id: r.id,
  applicationId: r.application_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  kind: r.kind,
  location: r.location,
  link: r.link,
  interviewers: json.parse(r.interviewers, []),
  notes: r.notes,
  company: r.company_name ?? '',
  title: r.title ?? '',
})

type StoryRow = { id: number; title: string; situation: string; task: string; action: string; result: string; fact_ids: string; tags: string; updated_at: number }
const story = (r: StoryRow): Story => ({ id: r.id, title: r.title, situation: r.situation, task: r.task, action: r.action, result: r.result, factIds: json.parse(r.fact_ids, []), tags: json.parse(r.tags, []), updatedAt: r.updated_at })

export function registerPrepHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx

  const jobFor = (applicationId: number) => {
    const a = db.get<{ job_id: number | null; title: string; company_name: string; company_id: number | null; url: string | null }>('SELECT job_id, title, company_name, company_id, url FROM applications WHERE id = ?', [applicationId])
    if (!a) throw new AppError('NOT_FOUND', 'That application no longer exists.', { permanent: true })
    const job = a.job_id ? db.get<{ description_md: string; url: string }>('SELECT description_md, url FROM jobs WHERE id = ?', [a.job_id]) : undefined
    return { a, job: { title: a.title, company: a.company_name, description: job?.description_md ?? '' }, url: job?.url ?? a.url }
  }

  // ---------------------------------------------------------------------------
  // Interviews

  const INTERVIEW_SELECT = 'SELECT i.*, a.company_name, a.title FROM interviews i LEFT JOIN applications a ON a.id = i.application_id'
  router.on('interviews.list', ({ range }) =>
    db.all<InterviewRow>(`${INTERVIEW_SELECT} ${range === 'upcoming' ? 'WHERE i.starts_at >= ?' : ''} ORDER BY i.starts_at`, range === 'upcoming' ? [ctx.now() - 2 * 3600_000] : []).map(interview),
  )
  router.on('interviews.save', (i) => {
    const values = [i.applicationId, i.startsAt, i.endsAt, i.kind, i.location, i.link, JSON.stringify(i.interviewers), i.notes]
    const id = i.id
      ? (db.run('UPDATE interviews SET application_id = ?, starts_at = ?, ends_at = ?, kind = ?, location = ?, link = ?, interviewers = ?, notes = ? WHERE id = ?', [...values, i.id]), i.id)
      : db.run("INSERT INTO interviews (application_id, starts_at, ends_at, kind, location, link, interviewers, notes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?)", [...values, ctx.now()]).lastInsertRowid
    if (!i.id && i.applicationId) addEvent(db, i.applicationId, 'interview', 'user', { interviewId: id, startsAt: i.startsAt }, ctx.now())
    ctx.bus.changed('interviews', 'applications')
    return interview(db.get<InterviewRow>(`${INTERVIEW_SELECT} WHERE i.id = ?`, [id])!)
  })
  router.on('interviews.delete', ({ id }) => {
    db.run('DELETE FROM interviews WHERE id = ?', [id])
    ctx.bus.changed('interviews')
    return null
  })

  // ---------------------------------------------------------------------------
  // Prep workspace (stored as prep_items per application)

  const prepState = (applicationId: number): Prep => {
    const items = db.all<{ kind: string; content: string; created_at: number }>('SELECT kind, content, created_at FROM prep_items WHERE application_id = ? ORDER BY id', [applicationId])
    const get = <T>(kind: string, d: T) => json.parse<T>(items.filter((x) => x.kind === kind).at(-1)?.content, d)
    const q = get<{ likely: Prep['likely']; ask: string[]; checklist: string[] }>('questions', { likely: [], ask: [], checklist: [] })
    return { applicationId, brief: get('brief', null), likely: q.likely, ask: q.ask, checklist: q.checklist, updatedAt: items.at(-1)?.created_at ?? null }
  }
  const savePrep = (applicationId: number, kind: string, content: unknown) => {
    db.tx(() => {
      db.run('DELETE FROM prep_items WHERE application_id = ? AND kind = ?', [applicationId, kind])
      db.run('INSERT INTO prep_items (application_id, kind, content, created_at) VALUES (?, ?, ?, ?)', [applicationId, kind, JSON.stringify(content), ctx.now()])
    })
    ctx.bus.changed('prep')
  }

  router.on('prep.get', ({ applicationId }) => prepState(applicationId))
  router.on('prep.generate', async ({ applicationId, part, kind }) => {
    const { a, job, url } = jobFor(applicationId)
    const { profile } = loadProfile(db)
    if (part === 'brief') {
      const sources: { url: string; text: string }[] = [{ url: 'posting', text: job.description }]
      const companyDomain = a.company_id ? db.get<{ domain: string | null }>('SELECT domain FROM companies WHERE id = ?', [a.company_id])?.domain : null
      const host = (() => {
        try {
          const h = new URL(url ?? '').hostname
          return isPlatformHost(h) ? null : baseDomain(h)
        } catch {
          return null
        }
      })()
      const domain = companyDomain ?? host
      if (domain) {
        try {
          const pages = await companyPages(ctx.http, domain)
          if (pages) sources.push({ url: `https://${domain}`, text: pages })
        } catch (err) {
          ctx.log.warn('brief pages failed', { err: errorMessage(err) })
        }
      }
      const brief = await s.ai.structured(briefPrompt, { job, sources }, { task: 'Company brief' })
      savePrep(applicationId, 'brief', sourcedOnly(brief, sources.map((x) => x.url)))
    } else {
      const q = await s.ai.structured(questionsPrompt, { job, profile, kind: kind as InterviewKind }, { task: 'Interview questions' })
      const known = new Set(factIds(profile))
      savePrep(applicationId, 'questions', { ...q, likely: q.likely.map((x) => ({ ...x, factIds: x.factIds.filter((f) => known.has(f)) })) })
    }
    return prepState(applicationId)
  })

  // ---------------------------------------------------------------------------
  // Story bank

  router.on('stories.list', () => db.all<StoryRow>('SELECT * FROM stories ORDER BY updated_at DESC').map(story))
  router.on('stories.save', (st) => {
    const id = st.id
      ? (db.run('UPDATE stories SET title = ?, situation = ?, task = ?, action = ?, result = ?, tags = ?, updated_at = ? WHERE id = ?', [st.title, st.situation, st.task, st.action, st.result, JSON.stringify(st.tags), ctx.now(), st.id]), st.id)
      : db.run('INSERT INTO stories (title, situation, task, action, result, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [st.title, st.situation, st.task, st.action, st.result, JSON.stringify(st.tags), ctx.now(), ctx.now()]).lastInsertRowid
    ctx.bus.changed('prep')
    return story(db.get<StoryRow>('SELECT * FROM stories WHERE id = ?', [id])!)
  })
  router.on('stories.delete', ({ id }) => {
    db.run('DELETE FROM stories WHERE id = ?', [id])
    ctx.bus.changed('prep')
    return null
  })
  router.on('stories.draft', async () => {
    const { profile } = loadProfile(db)
    if (!profile.work.length) throw new AppError('NO_PROFILE', 'Add your work history first; stories are built from it.', { permanent: true })
    const r = await s.ai.structured(storiesPrompt, { profile }, { task: 'Draft stories' })
    const known = new Set(factIds(profile))
    for (const st of r.stories) {
      const cited = st.factIds.filter((f) => known.has(f))
      // A story must rest on at least one real fact and add no numbers the profile does not have.
      if (!cited.length || unsupportedNumbers(`${st.situation} ${st.task} ${st.action} ${st.result}`, profile, '').length) continue
      db.run('INSERT INTO stories (title, situation, task, action, result, fact_ids, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [st.title, st.situation, st.task, st.action, st.result, JSON.stringify(cited), JSON.stringify(st.tags), ctx.now(), ctx.now()])
    }
    ctx.bus.changed('prep')
    return db.all<StoryRow>('SELECT * FROM stories ORDER BY updated_at DESC').map(story)
  })

  // ---------------------------------------------------------------------------
  // Mock interviews (chats of kind "mock")

  type ChatRow = { id: number; kind: string; ref_id: number | null; title: string; messages: string; updated_at: number }
  const session = (r: ChatRow): MockSession => {
    const m = json.parse<{ kind: string; messages: MockMessage[] }>(r.messages, { kind: 'other', messages: [] })
    return { id: r.id, applicationId: r.ref_id, kind: m.kind, title: r.title, messages: m.messages, updatedAt: r.updated_at }
  }
  const mockJob = (applicationId: number | null) => (applicationId ? jobFor(applicationId).job : { title: 'the role you are targeting', company: 'the company', description: '' })

  router.on('mock.list', () => db.all<ChatRow>("SELECT * FROM chats WHERE kind = 'mock' ORDER BY updated_at DESC").map(session))
  router.on('mock.start', async ({ applicationId, kind }) => {
    const job = mockJob(applicationId)
    const turn = await s.ai.structured(mockPrompt, { job, profile: loadProfile(db).profile, kind, history: [] }, { task: 'Mock interview' })
    const messages: MockMessage[] = [{ role: 'interviewer', text: turn.next }]
    const id = db.run("INSERT INTO chats (kind, ref_id, title, messages, created_at, updated_at) VALUES ('mock', ?, ?, ?, ?, ?)", [applicationId, `${kind} practice: ${job.company}`, JSON.stringify({ kind, messages }), ctx.now(), ctx.now()]).lastInsertRowid
    return session(db.get<ChatRow>('SELECT * FROM chats WHERE id = ?', [id])!)
  })
  router.on('mock.answer', async ({ id, answer }) => {
    const row = db.get<ChatRow>("SELECT * FROM chats WHERE id = ? AND kind = 'mock'", [id])
    if (!row) throw new AppError('NOT_FOUND', 'That practice session no longer exists.', { permanent: true })
    const cur = session(row)
    const history: MockMessage[] = [...cur.messages, { role: 'candidate', text: answer }]
    const turn = await s.ai.structured(mockPrompt, { job: mockJob(cur.applicationId), profile: loadProfile(db).profile, kind: cur.kind as InterviewKind, history }, { task: 'Mock interview' })
    history[history.length - 1] = { role: 'candidate', text: answer, feedback: turn.feedback }
    history.push({ role: 'interviewer', text: turn.next })
    db.run('UPDATE chats SET messages = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ kind: cur.kind, messages: history }), ctx.now(), id])
    return session(db.get<ChatRow>('SELECT * FROM chats WHERE id = ?', [id])!)
  })
  router.on('mock.delete', ({ id }) => {
    db.run("DELETE FROM chats WHERE id = ? AND kind = 'mock'", [id])
    return null
  })

  // ---------------------------------------------------------------------------
  // Offers

  const offerRow = (r: { id: number; application_id: number | null; data: string }): OfferRow => {
    const data = json.parse<Offer>(r.data, {} as Offer)
    return { id: r.id, applicationId: r.application_id, data, ...offerTotals(data) }
  }
  router.on('offers.list', () => db.all<{ id: number; application_id: number | null; data: string }>('SELECT * FROM offers ORDER BY created_at').map(offerRow))
  router.on('offers.save', ({ id, applicationId, data }) => {
    const oid = id
      ? (db.run('UPDATE offers SET application_id = ?, company = ?, data = ? WHERE id = ?', [applicationId, data.company, JSON.stringify(data), id]), id)
      : db.run('INSERT INTO offers (application_id, company, data, created_at) VALUES (?, ?, ?, ?)', [applicationId, data.company, JSON.stringify(data), ctx.now()]).lastInsertRowid
    ctx.bus.changed('applications')
    return offerRow(db.get<{ id: number; application_id: number | null; data: string }>('SELECT * FROM offers WHERE id = ?', [oid])!)
  })
  router.on('offers.delete', ({ id }) => {
    db.run('DELETE FROM offers WHERE id = ?', [id])
    return null
  })
  router.on('offers.negotiate', async ({ id, target }) => {
    const all = db.all<{ id: number; data: string }>('SELECT id, data FROM offers')
    const offer = all.find((o) => o.id === id)
    if (!offer) throw new AppError('NOT_FOUND', 'That offer no longer exists.', { permanent: true })
    const { profile } = loadProfile(db)
    const r = await s.ai.structured(negotiationPrompt, { profile, offer: json.parse(offer.data, {}), target, others: all.filter((o) => o.id !== id).map((o) => json.parse(o.data, {})), voice: loadVoice(db).description }, { task: 'Negotiation draft' })
    // Numbers may come from the offers and the target only.
    const issues = styleCheck(r.body, 'email')
    const nums = unsupportedNumbers(r.body, profile, `${all.map((o) => o.data).join(' ')} ${target}`)
    if (nums.length) issues.push({ rule: 'fact', excerpt: nums.join(', '), message: `These numbers are not in your offers or target: ${nums.join(', ')}.` })
    return { ...r, issues }
  })

  // ---------------------------------------------------------------------------
  // Career tools

  router.on('career.skillsGap', ({ huntId }) => skillsGap(db, huntId, ctx.now() - 60 * 86_400_000))
  router.on('career.explore', () => careerExplorer(db, loadProfile(db).profile, ctx.now() - 90 * 86_400_000, listHunts(db).flatMap((h) => h.config.titles)))
  router.on('career.linkedinPost', async ({ topic }) => {
    const { profile } = loadProfile(db)
    const r = await s.ai.structured(linkedinPostPrompt, { profile, topic, voice: loadVoice(db).description }, { task: 'LinkedIn post' })
    const issues = styleCheck(r.text, 'answer')
    const nums = unsupportedNumbers(r.text, profile, topic)
    if (nums.length) issues.push({ rule: 'fact', excerpt: nums.join(', '), message: `These numbers are not in your profile: ${nums.join(', ')}.` })
    return { text: r.text, issues }
  })

  // ---------------------------------------------------------------------------
  // Assistant (chats of kind "assistant")

  const chat = (r: ChatRow): Chat => ({ id: r.id, title: r.title, messages: json.parse<ChatMessage[]>(r.messages, []), updatedAt: r.updated_at })
  router.on('assistant.list', () => db.all<ChatRow>("SELECT * FROM chats WHERE kind = 'assistant' ORDER BY updated_at DESC LIMIT 100").map(chat))
  router.on('assistant.get', ({ id }) => {
    const r = db.get<ChatRow>("SELECT * FROM chats WHERE id = ? AND kind = 'assistant'", [id])
    if (!r) throw new AppError('NOT_FOUND', 'That conversation no longer exists.', { permanent: true })
    return chat(r)
  })
  router.on('assistant.send', async ({ id, text }) => {
    const existing = id ? db.get<ChatRow>("SELECT * FROM chats WHERE id = ? AND kind = 'assistant'", [id]) : undefined
    const history = existing ? chat(existing).messages : []
    const reply = await assistantTurn(ctx, s.ai, history, text)
    const messages: ChatMessage[] = [...history, { role: 'user', text, at: ctx.now() }, reply]
    const cid = existing
      ? (db.run('UPDATE chats SET messages = ?, updated_at = ? WHERE id = ?', [JSON.stringify(messages), ctx.now(), existing.id]), existing.id)
      : db.run("INSERT INTO chats (kind, title, messages, created_at, updated_at) VALUES ('assistant', ?, ?, ?, ?)", [text.slice(0, 60), JSON.stringify(messages), ctx.now(), ctx.now()]).lastInsertRowid
    return chat(db.get<ChatRow>('SELECT * FROM chats WHERE id = ?', [cid])!)
  })
  router.on('assistant.delete', ({ id }) => {
    db.run("DELETE FROM chats WHERE id = ? AND kind = 'assistant'", [id])
    return null
  })
}
