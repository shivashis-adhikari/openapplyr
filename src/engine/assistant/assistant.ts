import { type ModelMessage, tool } from 'ai'
import { z } from 'zod'
import { HuntConfigSchema } from '../../shared/domain'
import type { AiService } from '../ai/service'
import { json } from '../core/db'
import { errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { listJobs } from '../jobs/queries'
import { listHunts } from '../match/hunts'
import { analytics } from '../tracker/analytics'
import { addEvent } from '../tracker/applications'
import { listApplications } from '../tracker/queries'
import { offerTotals, type Offer, skillsGap } from '../career/insights'

export type ChatMessage =
  | { role: 'user'; text: string; at: number }
  | { role: 'assistant'; text: string; at: number; actions: ChatAction[] }

/** Things the assistant did or proposes. Proposals are applied by the user in the app, never by the assistant. */
export type ChatAction =
  | { kind: 'looked_up'; what: string }
  | { kind: 'note_added'; applicationId: number; text: string }
  | { kind: 'hunt_change'; huntId: number; huntName: string; patch: Record<string, unknown>; reason: string }
  | { kind: 'draft_request'; applicationId: number; purpose: string }

const MAX_STEPS = 6

const SYSTEM = [
  "You are the assistant inside OpenApplyr, a job-search app running on the user's computer. You answer from the user's own data through the tools.",
  'Be brief and specific: numbers, company names, dates. Say when the data does not answer the question.',
  'You cannot send, submit, apply or delete anything. When the user wants a message or a hunt change, propose it with the tool; the user approves it in the app.',
].join(' ')

type ToolRun = (input: unknown) => unknown

/** Tools over local data. Reads return compact JSON; the only writes are notes and proposals. */
function toolset(ctx: Ctx, actions: ChatAction[]) {
  const { db } = ctx
  const now = ctx.now()
  const defs = {
    search_jobs: {
      t: tool({ description: 'Search jobs in the local database by keywords. Returns title, company, score, location.', inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(10) }) }),
      run: (i: { query: string; limit: number }) =>
        listJobs(db, { huntId: null, view: 'all', q: i.query, remote: [], employment: [], minScore: 0, hideWarnings: false, sort: 'score', limit: i.limit, offset: 0 }, now).rows.map((j) => ({ id: j.id, title: j.title, company: j.company, score: j.score, location: j.location })),
    },
    explain_score: {
      t: tool({ description: 'The score breakdown and per-requirement verdicts for one job.', inputSchema: z.object({ jobId: z.number().int() }) }),
      run: (i: { jobId: number }) => {
        const r = db.get<{ score: number | null; breakdown: string | null; judgment: string | null; reasons: string }>('SELECT score, breakdown, judgment, reasons FROM job_scores WHERE job_id = ? ORDER BY score DESC LIMIT 1', [i.jobId])
        if (!r) return { error: 'This job has not been scored.' }
        const j = json.parse<{ requirements?: { text: string; verdict: string; kind: string }[]; summary?: string } | null>(r.judgment, null)
        return { score: r.score, breakdown: json.parse(r.breakdown, null), summary: j?.summary, requirements: j?.requirements?.map((q) => `${q.kind} ${q.verdict}: ${q.text}`), filteredBecause: json.parse(r.reasons, []) }
      },
    },
    list_applications: {
      t: tool({ description: 'Applications, optionally filtered by status or text.', inputSchema: z.object({ status: z.string().optional(), q: z.string().default('') }) }),
      run: (i: { status?: string; q: string }) =>
        listApplications(db, { q: i.q, statuses: i.status ? [i.status as never] : [], huntId: null, archived: false }).slice(0, 40).map((a) => ({ id: a.id, company: a.company, title: a.title, status: a.status, appliedAt: a.appliedAt ? new Date(a.appliedAt).toISOString().slice(0, 10) : null })),
    },
    week_summary: {
      t: tool({ description: 'Counts for the last 7 and 30 days: applied, responses, interviews, spend; plus response rates.', inputSchema: z.object({}) }),
      run: () => {
        const week = analytics(db, now - 7 * 86_400_000, now)
        const month = analytics(db, now - 30 * 86_400_000, now)
        const pick = (a: typeof week) => ({ applied: a.applied, responded: a.responded, interview: a.interview, offer: a.offer, medianDaysToResponse: a.medianDaysToResponse, spend: Math.round(a.spend.total * 100) / 100 })
        return { last7Days: pick(week), last30Days: pick(month), notes: month.notes }
      },
    },
    skills_gap: {
      t: tool({ description: 'Requirements the user is missing most often across recent matches.', inputSchema: z.object({ huntId: z.number().int().nullable().default(null) }) }),
      run: (i: { huntId: number | null }) => skillsGap(db, i.huntId, now - 60 * 86_400_000),
    },
    compare_offers: {
      t: tool({ description: 'The user\'s offers with first-year and average yearly totals.', inputSchema: z.object({}) }),
      run: () => db.all<{ id: number; data: string }>('SELECT id, data FROM offers').map((o) => {
        const d = json.parse<Offer>(o.data, {} as Offer)
        return { id: o.id, company: d.company, title: d.title, currency: d.currency, base: d.base, ...offerTotals(d) }
      }),
    },
    add_note: {
      t: tool({ description: 'Add a note to an application.', inputSchema: z.object({ applicationId: z.number().int(), text: z.string().min(1).max(2000) }) }),
      run: (i: { applicationId: number; text: string }) => {
        const r = db.run("UPDATE applications SET notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END WHERE id = ?", [i.text, i.text, i.applicationId])
        if (!r.changes) return { error: 'No such application.' }
        addEvent(db, i.applicationId, 'note', 'user', { text: i.text, by: 'assistant' }, now)
        actions.push({ kind: 'note_added', applicationId: i.applicationId, text: i.text })
        ctx.bus.changed('applications')
        return { ok: true }
      },
    },
    propose_hunt_change: {
      t: tool({
        description: 'Propose a change to a hunt\'s settings (for example titles, locations, salary floor, thresholds). The user reviews and applies it.',
        inputSchema: z.object({ huntId: z.number().int(), patch: z.record(z.string(), z.unknown()), reason: z.string() }),
      }),
      run: (i: { huntId: number; patch: Record<string, unknown>; reason: string }) => {
        const hunt = listHunts(db).find((h) => h.id === i.huntId)
        if (!hunt) return { error: 'No such hunt.' }
        const check = HuntConfigSchema.safeParse({ ...hunt.config, ...i.patch })
        if (!check.success) return { error: `That change is not valid: ${check.error.issues[0]?.message}` }
        actions.push({ kind: 'hunt_change', huntId: hunt.id, huntName: hunt.name, patch: i.patch, reason: i.reason })
        return { proposed: true, note: 'Shown to the user to apply.' }
      },
    },
    request_draft: {
      t: tool({ description: 'Ask for a message draft to someone about an application (recruiter_intro, hiring_manager, referral, follow_up, thank_you). It appears for the user to review; it is not sent.', inputSchema: z.object({ applicationId: z.number().int(), purpose: z.string() }) }),
      run: (i: { applicationId: number; purpose: string }) => {
        actions.push({ kind: 'draft_request', applicationId: i.applicationId, purpose: i.purpose })
        return { proposed: true }
      },
    },
  }
  const tools = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.t]))
  const run = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.run as ToolRun])) as Record<string, ToolRun>
  return { tools, run }
}

/** One user turn: the model may call tools up to MAX_STEPS times before answering. */
export async function assistantTurn(ctx: Ctx, ai: AiService, history: ChatMessage[], text: string, signal?: AbortSignal): Promise<ChatMessage> {
  const actions: ChatAction[] = []
  const { tools, run } = toolset(ctx, actions)
  const messages: ModelMessage[] = [
    ...history.slice(-12).map((m): ModelMessage => (m.role === 'user' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text })),
    { role: 'user', content: text },
  ]
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await ai.turn({
      role: 'agent',
      task: 'Assistant',
      system: `${SYSTEM}\nToday is ${new Date(ctx.now()).toDateString()}.`,
      messages,
      tools,
      maxOutputTokens: 1200,
      signal,
      mock: () => mockTurn(text, messages),
    })
    if (!r.toolCalls.length) return { role: 'assistant', text: r.text.trim() || 'I could not find an answer in your data.', at: ctx.now(), actions }
    messages.push({ role: 'assistant', content: r.toolCalls.map((c, i) => ({ type: 'tool-call' as const, toolCallId: c.toolCallId ?? `call_${step}_${i}`, toolName: c.toolName, input: c.input })) })
    messages.push({
      role: 'tool',
      content: r.toolCalls.map((c, i) => {
        let value: unknown
        try {
          value = run[c.toolName] ? run[c.toolName]!(c.input) : { error: 'Unknown tool.' }
        } catch (err) {
          value = { error: errorMessage(err) }
        }
        actions.push({ kind: 'looked_up', what: c.toolName })
        return { type: 'tool-result' as const, toolCallId: c.toolCallId ?? `call_${step}_${i}`, toolName: c.toolName, output: { type: 'json' as const, value: JSON.parse(JSON.stringify(value ?? null)) } }
      }),
    })
  }
  return { role: 'assistant', text: 'That took more lookups than I allow for one question. Try asking about one thing at a time.', at: ctx.now(), actions }
}

/** Offline demo: one lookup for common questions, then a plain summary of the result. */
function mockTurn(text: string, messages: ModelMessage[]): { text: string; toolCalls?: { toolName: string; input: unknown; toolCallId: string }[] } {
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    const out = (last.content[0] as { output: { value: unknown } }).output.value
    return { text: `Here is what your data shows:\n\n${JSON.stringify(out, null, 2).slice(0, 1500)}` }
  }
  if (/week|month|how am i doing|summary|progress/i.test(text)) return { text: '', toolCalls: [{ toolName: 'week_summary', input: {}, toolCallId: 'm1' }] }
  if (/gap|missing|skill/i.test(text)) return { text: '', toolCalls: [{ toolName: 'skills_gap', input: { huntId: null }, toolCallId: 'm1' }] }
  if (/offer/i.test(text)) return { text: '', toolCalls: [{ toolName: 'compare_offers', input: {}, toolCallId: 'm1' }] }
  if (/application|applied|status/i.test(text)) return { text: '', toolCalls: [{ toolName: 'list_applications', input: { q: '' }, toolCallId: 'm1' }] }
  return { text: '', toolCalls: [{ toolName: 'search_jobs', input: { query: text.replace(/[^\w\s]/g, ' ').trim().slice(0, 80), limit: 8 }, toolCallId: 'm1' }] }
}
