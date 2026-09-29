import { z } from 'zod'
import type { Interview, StyleIssue } from '../domain'
import { proc } from './define'

export const INTERVIEW_KINDS = ['recruiter', 'technical', 'behavioral', 'onsite', 'final', 'other'] as const
export type BriefPoint = { text: string; source: string }
export type Prep = {
  applicationId: number
  brief: { sections: { heading: string; points: BriefPoint[] }[] } | null
  likely: { question: string; why: string; factIds: string[] }[]
  ask: string[]
  checklist: string[]
  updatedAt: number | null
}
export type Story = { id: number; title: string; situation: string; task: string; action: string; result: string; factIds: string[]; tags: string[]; updatedAt: number }
export type Score = { score: number; note: string }
export type MockMessage = { role: 'interviewer' | 'candidate'; text: string; feedback?: { structure: Score; specificity: Score; relevance: Score; length: Score; stronger: string } | null }
export type MockSession = { id: number; applicationId: number | null; kind: string; title: string; messages: MockMessage[]; updatedAt: number }
export type OfferData = { company: string; title: string; currency: string; base: number; bonusPct: number; signOn: number; equityValue: number; vestingYears: number; cliffMonths: number; benefits: string; location: string; deadline: string }
export type OfferRow = { id: number; applicationId: number | null; data: OfferData; firstYear: number; averageYear: number }
export type GapRow = { term: string; missing: number; mustHave: number; jobs: number }
export type AdjacentTitle = { title: string; postings: number; overlap: number; have: string[]; missing: string[] }
export type ChatAction =
  | { kind: 'looked_up'; what: string }
  | { kind: 'note_added'; applicationId: number; text: string }
  | { kind: 'hunt_change'; huntId: number; huntName: string; patch: Record<string, unknown>; reason: string }
  | { kind: 'draft_request'; applicationId: number; purpose: string }
export type ChatMessage = { role: 'user'; text: string; at: number } | { role: 'assistant'; text: string; at: number; actions: ChatAction[] }
export type Chat = { id: number; title: string; messages: ChatMessage[]; updatedAt: number }

const Id = z.object({ id: z.number().int() })
const Offer = z.object({
  company: z.string().trim().min(1, 'Enter the company.'),
  title: z.string().max(200).default(''),
  currency: z.string().length(3).default('USD'),
  base: z.number().min(0),
  bonusPct: z.number().min(0).max(200).default(0),
  signOn: z.number().min(0).default(0),
  equityValue: z.number().min(0).default(0),
  vestingYears: z.number().min(0).max(10).default(4),
  cliffMonths: z.number().int().min(0).max(48).default(12),
  benefits: z.string().max(5000).default(''),
  location: z.string().max(200).default(''),
  deadline: z.string().max(40).default(''),
})

export const prepApi = {
  'interviews.list': proc<Interview[]>()(z.object({ range: z.enum(['upcoming', 'all']).default('upcoming') })),
  'interviews.save': proc<Interview>()(
    z.object({
      id: z.number().int().optional(),
      applicationId: z.number().int().nullable(),
      startsAt: z.number().int().nullable(),
      endsAt: z.number().int().nullable().default(null),
      kind: z.enum(INTERVIEW_KINDS),
      location: z.string().max(500).nullable().default(null),
      link: z.string().url().nullable().default(null),
      interviewers: z.array(z.string().max(200)).max(20).default([]),
      notes: z.string().max(50_000).default(''),
    }),
  ),
  'interviews.delete': proc<null>()(Id),

  'prep.get': proc<Prep>()(z.object({ applicationId: z.number().int() })),
  'prep.generate': proc<Prep>()(z.object({ applicationId: z.number().int(), part: z.enum(['brief', 'questions']), kind: z.enum(INTERVIEW_KINDS).default('other') })),

  'stories.list': proc<Story[]>()(z.void()),
  'stories.save': proc<Story>()(
    z.object({ id: z.number().int().optional(), title: z.string().trim().min(1).max(200), situation: z.string().max(5000), task: z.string().max(5000), action: z.string().max(5000), result: z.string().max(5000), tags: z.array(z.string().max(40)).max(10).default([]) }),
  ),
  'stories.delete': proc<null>()(Id),
  'stories.draft': proc<Story[]>()(z.void()),

  'mock.list': proc<MockSession[]>()(z.void()),
  'mock.start': proc<MockSession>()(z.object({ applicationId: z.number().int().nullable(), kind: z.enum(INTERVIEW_KINDS) })),
  'mock.answer': proc<MockSession>()(z.object({ id: z.number().int(), answer: z.string().trim().min(1, 'Type or paste your answer.').max(10_000) })),
  'mock.delete': proc<null>()(Id),

  'offers.list': proc<OfferRow[]>()(z.void()),
  'offers.save': proc<OfferRow>()(z.object({ id: z.number().int().optional(), applicationId: z.number().int().nullable().default(null), data: Offer })),
  'offers.delete': proc<null>()(Id),
  'offers.negotiate': proc<{ subject: string; body: string; issues: StyleIssue[] }>()(z.object({ id: z.number().int(), target: z.string().max(200).default('') })),

  'career.skillsGap': proc<{ jobs: number; rows: GapRow[] }>()(z.object({ huntId: z.number().int().nullable().default(null) })),
  'career.explore': proc<AdjacentTitle[]>()(z.void()),
  'career.linkedinPost': proc<{ text: string; issues: StyleIssue[] }>()(z.object({ topic: z.string().trim().min(10, 'Say what the post is about.').max(1000) })),

  'assistant.list': proc<Chat[]>()(z.void()),
  'assistant.get': proc<Chat>()(Id),
  'assistant.send': proc<Chat>()(z.object({ id: z.number().int().nullable(), text: z.string().trim().min(1).max(4000) })),
  'assistant.delete': proc<null>()(Id),
}
