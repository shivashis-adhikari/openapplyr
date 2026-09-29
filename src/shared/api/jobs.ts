import { z } from 'zod'
import { EMPLOYMENT, type Hunt, HuntConfigSchema, type HuntStats, type JobDetail, type JobScore, type JobSummary, REMOTE } from '../domain'
import { proc } from './define'

export const JOB_VIEWS = ['matches', 'new', 'all', 'saved', 'skipped', 'filtered', 'applied'] as const
export type JobView = (typeof JOB_VIEWS)[number]
export const SKIP_REASONS = ['level', 'location', 'domain', 'company', 'salary', 'role', 'other'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export type JobList = { rows: JobSummary[]; total: number; counts: Record<JobView, number> }
export type HuntPreview = { total: number; pass: number; reasons: { reason: string; count: number }[] }
export type HuntSuggestion = { id: string; text: string; patch: Partial<z.input<typeof HuntConfigSchema>> }
export type WatchedSource = { id: number; kind: string; label: string; key: string; origin: string; enabled: boolean; jobCount: number; lastOkAt: number | null; lastError: string | null; consecutiveErrors: number }
export type IntegrationInfo = {
  kind: string
  label: string
  url: string
  connected: boolean
  enabled: boolean
  config: Record<string, string>
  secretsSet: string[]
  fields: { key: string; secret: boolean }[]
}

const Id = z.object({ id: z.number().int() })
const HuntInput = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, 'Give the hunt a name.').max(80),
  mode: z.enum(['manual', 'review', 'autopilot']),
  active: z.boolean(),
  baseResumeId: z.number().int().nullable(),
  config: HuntConfigSchema,
})

export const jobsApi = {
  'jobs.list': proc<JobList>()(
    z.object({
      huntId: z.number().int().nullable().default(null),
      view: z.enum(JOB_VIEWS).default('matches'),
      q: z.string().max(200).default(''),
      remote: z.array(z.enum(REMOTE)).default([]),
      employment: z.array(z.enum(EMPLOYMENT)).default([]),
      minScore: z.number().min(0).max(100).default(0),
      hideWarnings: z.boolean().default(false),
      sort: z.enum(['score', 'newest', 'posted']).default('score'),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }),
  ),
  'jobs.get': proc<JobDetail>()(Id),
  'jobs.setState': proc<null>()(z.object({ id: z.number().int(), state: z.enum(['saved', 'skipped']).nullable(), reason: z.enum(SKIP_REASONS).optional(), huntId: z.number().int().nullable().optional() })),
  'jobs.importUrl': proc<{ id: number }>()(z.object({ url: z.string().url('Paste a full link starting with https://') })),
  'jobs.importText': proc<{ id: number }>()(z.object({ text: z.string().min(80, 'Paste the whole posting.').max(100_000), url: z.string().url().nullable().default(null) })),
  'jobs.rescore': proc<JobScore>()(z.object({ id: z.number().int(), huntId: z.number().int() })),
  'companies.setBlocked': proc<null>()(z.object({ id: z.number().int(), blocked: z.boolean() })),
  'sources.watch': proc<{ sourceId: number; ats: string; key: string }>()(z.object({ url: z.string().url() })),
  'sources.list': proc<WatchedSource[]>()(z.object({ origin: z.enum(['user', 'builtin', 'all']).default('user'), limit: z.number().int().max(5000).default(500) })),
  'sources.setEnabled': proc<null>()(z.object({ id: z.number().int(), enabled: z.boolean() })),
  'sources.pollNow': proc<null>()(Id),
  'sources.remove': proc<null>()(Id),
  'integrations.list': proc<IntegrationInfo[]>()(z.void()),
  'integrations.save': proc<IntegrationInfo[]>()(z.object({ kind: z.string(), values: z.record(z.string(), z.string().max(2000)), enabled: z.boolean().default(true) })),
  'integrations.delete': proc<IntegrationInfo[]>()(z.object({ kind: z.string() })),
  'hunts.list': proc<{ hunt: Hunt; stats: HuntStats }[]>()(z.void()),
  'hunts.get': proc<Hunt>()(Id),
  'hunts.save': proc<Hunt>()(HuntInput),
  'hunts.delete': proc<null>()(Id),
  'hunts.preview': proc<HuntPreview>()(z.object({ config: HuntConfigSchema })),
  'hunts.runNow': proc<null>()(z.object({ id: z.number().int().optional() })),
  'hunts.suggestTitles': proc<string[]>()(z.object({ titles: z.array(z.string().min(1)).min(1).max(10) })),
  'hunts.suggestions': proc<HuntSuggestion[]>()(Id),
}
