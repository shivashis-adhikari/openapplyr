import type { z } from 'zod'
import { aiApi } from './ai'
import { applicationsApi } from './applications'
import { coreApi } from './core'
import { documentsApi } from './documents'
import { jobsApi } from './jobs'
import { mailApi } from './mail'
import { outreachApi } from './outreach'
import { packagesApi } from './packages'
import { prepApi } from './prep'
import { runsApi } from './runs'
import { profileApi } from './profile'

export const api = {
  ...coreApi,
  ...aiApi,
  ...profileApi,
  ...jobsApi,
  ...documentsApi,
  ...packagesApi,
  ...runsApi,
  ...applicationsApi,
  ...mailApi,
  ...outreachApi,
  ...prepApi,
}

export type Api = typeof api
export type ProcName = keyof Api
/** What callers send (defaults not yet applied). */
export type ProcInput<N extends ProcName> = z.input<Api[N]['input']>
/** What handlers receive (after validation and defaults). */
export type ProcArgs<N extends ProcName> = z.output<Api[N]['input']>
export type ProcOutput<N extends ProcName> = Api[N]['output']
