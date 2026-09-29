import { z } from 'zod'
import { APP_STATUSES, type ApplicationDetail, type ApplicationSummary } from '../domain'
import { proc } from './define'

export type ImportField = 'company' | 'title' | 'status' | 'appliedAt' | 'url' | 'location' | 'notes'
export type ImportPreview = { headers: string[]; sample: Record<string, string>[]; mapping: Partial<Record<ImportField, string>>; rows: number }
export type ImportResult = { imported: number; skipped: number; duplicates: number; errors: string[] }
export type GroupRate = { key: string; applied: number; responded: number; rate: number }
export type Analytics = {
  since: number | null
  applied: number
  responded: number
  screen: number
  interview: number
  offer: number
  rejected: number
  ghosted: number
  medianDaysToResponse: number | null
  byChannel: GroupRate[]
  byTemplate: GroupRate[]
  byHunt: GroupRate[]
  byTitle: GroupRate[]
  byDaysAfterPosting: GroupRate[]
  weekly: { week: number; applied: number; responses: number; spend: number }[]
  spend: { total: number; perApplication: number | null }
  notes: string[]
}

const Id = z.object({ id: z.number().int() })
const Status = z.enum(APP_STATUSES)
const Ids = z.array(z.number().int()).min(1).max(1000)
const Mapping = z.object({ company: z.string(), title: z.string(), status: z.string(), appliedAt: z.string(), url: z.string(), location: z.string(), notes: z.string() }).partial()

export const applicationsApi = {
  'applications.list': proc<ApplicationSummary[]>()(
    z.object({ q: z.string().max(200).default(''), statuses: z.array(Status).default([]), huntId: z.number().int().nullable().default(null), archived: z.boolean().default(false) }),
  ),
  'applications.get': proc<ApplicationDetail>()(Id),
  'applications.setStatus': proc<null>()(z.object({ ids: Ids, status: Status, note: z.string().max(2000).optional() })),
  'applications.update': proc<null>()(z.object({ id: z.number().int(), notes: z.string().max(50_000).optional(), url: z.string().url().nullable().optional() })),
  /** An application made somewhere else, so the tracker and analytics see everything. */
  'applications.add': proc<{ id: number }>()(
    z.object({
      company: z.string().trim().min(1, 'Enter the company.').max(200),
      title: z.string().trim().min(1, 'Enter the job title.').max(200),
      url: z.string().url().nullable().default(null),
      status: Status.default('applied'),
      appliedAt: z.number().int().nullable().default(null),
      channel: z.enum(['ats', 'email', 'referral', 'other']).default('other'),
      notes: z.string().max(10_000).default(''),
      jobId: z.number().int().nullable().default(null),
    }),
  ),
  'applications.archive': proc<null>()(z.object({ ids: Ids, archived: z.boolean() })),
  'applications.export': proc<{ path: string }>()(z.object({ format: z.enum(['csv', 'json']), path: z.string().min(1) })),
  'applications.importPreview': proc<ImportPreview>()(z.object({ path: z.string().min(1) })),
  'applications.import': proc<ImportResult>()(z.object({ path: z.string().min(1), mapping: Mapping })),
  'analytics.summary': proc<Analytics>()(z.object({ range: z.enum(['30d', '90d', 'all']).default('90d') })),
}
