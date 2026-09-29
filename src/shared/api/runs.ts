import { z } from 'zod'
import type { RunDetail, RunSummary } from '../domain'
import { proc } from './define'

const Id = z.object({ id: z.number().int() })

export const runsApi = {
  'runs.list': proc<RunSummary[]>()(z.object({ filter: z.enum(['active', 'recent']).default('recent'), applicationId: z.number().int().nullable().default(null) })),
  'runs.get': proc<RunDetail>()(Id),
  /** Answers the question a paused run is waiting on, or tells it to carry on after the user acted in the browser. */
  'runs.reply': proc<null>()(
    z.object({
      id: z.number().int(),
      reply: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('answer'), fieldName: z.string().min(1), answer: z.string().trim().min(1, 'Type an answer.').max(10_000), save: z.enum(['no', 'all', 'company']).default('all') }),
        z.object({ kind: z.literal('continue') }),
      ]),
    }),
  ),
  'runs.stop': proc<null>()(Id),
  /** Runs an application again: after a dry run ("Send for real"), after a failure, or in assisted mode. */
  'applications.run': proc<null>()(z.object({ id: z.number().int(), mode: z.enum(['submit', 'dry_run', 'assisted']).optional() })),
}
