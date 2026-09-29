import { z } from 'zod'
import type { AnswerKind, PackageDetail, PackageSummary } from '../domain'
import { proc } from './define'
import { SKIP_REASONS } from './jobs'

export type SavedAnswer = { id: number; key: string; question: string; answer: string; kind: AnswerKind; company: string | null; source: string; usedCount: number; updatedAt: number }

const Id = z.object({ id: z.number().int() })

export const packagesApi = {
  'packages.list': proc<PackageSummary[]>()(z.object({ filter: z.enum(['queue', 'approved', 'done', 'all']).default('queue') })),
  'packages.get': proc<PackageDetail>()(Id),
  /** Prepare a package for one job now (the "Prepare" button, or manual hunts). */
  'packages.prepareNow': proc<{ queued: boolean }>()(z.object({ jobId: z.number().int(), huntId: z.number().int().nullable().default(null) })),
  /** "assisted": OpenApplyr fills the form and you press submit yourself. */
  'packages.approve': proc<{ applicationId: number }>()(z.object({ id: z.number().int(), mode: z.enum(['assisted']).optional() })),
  'packages.approveMany': proc<{ approved: number[]; failed: { id: number; message: string }[] }>()(z.object({ ids: z.array(z.number().int()).min(1).max(200) })),
  'packages.skip': proc<null>()(z.object({ id: z.number().int(), reason: z.enum(SKIP_REASONS).nullable().default(null) })),
  'packages.updateAnswer': proc<PackageDetail>()(
    z.object({ id: z.number().int(), fieldName: z.string().min(1), answer: z.string().max(10_000), save: z.enum(['no', 'all', 'company']).default('no') }),
  ),
  'packages.setResume': proc<PackageDetail>()(z.object({ id: z.number().int(), resumeId: z.number().int() })),
  'packages.regenerate': proc<null>()(Id),

  'answers.list': proc<SavedAnswer[]>()(z.object({ q: z.string().max(200).default('') })),
  'answers.save': proc<SavedAnswer[]>()(z.object({ id: z.number().int(), answer: z.string().trim().min(1, 'An empty answer cannot be saved.').max(10_000) })),
  'answers.delete': proc<null>()(Id),
}
