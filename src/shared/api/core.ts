import { z } from 'zod'
import type { Settings } from '../settings'
import { proc } from './define'

export type EngineStatus = {
  version: string
  demo: boolean
  paused: boolean
  onboarded: boolean
  activeTasks: number
  activeRuns: number
  needsYou: number
  spendToday: number
  spendMonth: number
  budgetDaily: number
  budgetMonthly: number
  unpricedCallsToday: number
  nextScanAt: number | null
  dataDir: string
}

export type TodayItem = {
  kind: 'question' | 'dry_run' | 'failed' | 'unverified' | 'package' | 'package_answers' | 'package_failed' | 'mail' | 'outbox' | 'mail_auth'
  id: number
  runId: number | null
  fieldName: string | null
  title: string
  detail: string
  at: number
}
export type TodaySummary = {
  items: TodayItem[]
  counts: { needsYou: number; appliedToday: number; repliesToday: number; matchesToday: number; sentToday: number; applying: number }
  setup: { model: boolean; profile: boolean; hunt: boolean; mail: boolean }
  interviews: { id: number; applicationId: number | null; startsAt: number; kind: string; company: string; title: string; link: string | null }[]
}

export type ActivityTask = {
  id: number
  type: string
  status: string
  attempts: number
  runAt: number
  lastError: string | null
  finishedAt: number | null
  label: string
}

export type SourceHealth = {
  id: number
  kind: string
  label: string
  enabled: boolean
  jobCount: number
  lastPolledAt: number | null
  lastOkAt: number | null
  consecutiveErrors: number
  lastError: string | null
  nextPollAt: number
}

export type LedgerRow = {
  id: number
  at: number
  provider: string
  model: string
  role: string
  task: string
  inputTokens: number | null
  outputTokens: number | null
  cost: number | null
  ok: boolean
  error: string | null
}

const SettingsPatchSchema = z.record(z.string(), z.unknown())

export const coreApi = {
  'app.status': proc<EngineStatus>()(z.void()),
  'today.summary': proc<TodaySummary>()(z.void()),
  'app.pause': proc<EngineStatus>()(z.object({ paused: z.boolean() })),
  'settings.get': proc<Settings>()(z.void()),
  'settings.update': proc<Settings>()(SettingsPatchSchema),
  'activity.tasks': proc<ActivityTask[]>()(z.object({ status: z.enum(['all', 'failed', 'pending', 'running']).default('all'), limit: z.number().int().max(500).default(200) })),
  'activity.sources': proc<SourceHealth[]>()(z.object({ onlyProblems: z.boolean().default(false), limit: z.number().int().max(2000).default(300) })),
  'activity.ledger': proc<LedgerRow[]>()(z.object({ limit: z.number().int().max(1000).default(200) })),
  'activity.retryTask': proc<null>()(z.object({ id: z.number().int() })),
  'data.backupNow': proc<{ path: string }>()(z.void()),
  'data.export': proc<{ path: string }>()(z.object({ path: z.string().min(1) })),
  'data.deleteAll': proc<null>()(z.object({ confirm: z.literal('DELETE') })),
  'data.revealDataDir': proc<null>()(z.void()),
}
