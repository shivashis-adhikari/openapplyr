import { z } from 'zod'
import { APP_STATUSES, type AppStatus } from '../domain'
import { proc } from './define'

export type MailPresetInfo = { id: string; label: string; auth: 'app_password' | 'oauth' | 'password'; helpUrl: string | null; needsServers: boolean }
export type MailAccountInfo = { id: number; provider: string; address: string; displayName: string | null; status: string; statusDetail: string | null; lastSyncAt: number | null; dailyCap: number; sentToday: number }
export type MailSuggestion = { applicationId: number; company: string; title: string; score: number }
export type InboxItem = {
  id: number
  accountId: number
  from: string
  fromName: string
  subject: string
  snippet: string
  date: number
  category: string | null
  confidence: number | null
  code: string | null
  applicationId: number | null
  company: string | null
  title: string | null
  needsReview: boolean
  suggestions: MailSuggestion[]
  suggestedStatus: AppStatus | null
}

const Server = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), secure: z.boolean() })
const Id = z.object({ id: z.number().int() })

export const mailApi = {
  'mail.presets': proc<MailPresetInfo[]>()(z.void()),
  'mail.accounts': proc<MailAccountInfo[]>()(z.void()),
  'mail.connect': proc<MailAccountInfo>()(
    z.object({
      preset: z.string(),
      address: z.string().trim().email('Enter the full email address.'),
      password: z.string().min(1, 'Enter the app password.'),
      displayName: z.string().max(120).optional(),
      imap: Server.optional(),
      smtp: Server.optional(),
    }),
  ),
  /** Microsoft (and Google with the user's own client): opens the browser to sign in. */
  'mail.connectOAuth': proc<MailAccountInfo>()(
    z.object({ provider: z.enum(['microsoft', 'google']), clientId: z.string().trim().min(8, 'Enter the client ID.'), clientSecret: z.string().optional(), address: z.string().email().optional(), displayName: z.string().max(120).optional() }),
  ),
  'mail.update': proc<null>()(z.object({ id: z.number().int(), dailyCap: z.number().int().min(1).max(50).optional(), displayName: z.string().max(120).optional() })),
  'mail.disconnect': proc<null>()(Id),
  'mail.syncNow': proc<null>()(z.object({ id: z.number().int().nullable().default(null) })),

  'inbox.list': proc<InboxItem[]>()(z.object({ filter: z.enum(['review', 'linked', 'all']).default('all'), q: z.string().max(200).default('') })),
  'inbox.body': proc<{ text: string }>()(Id),
  /** Confirms or corrects a message's application, and optionally applies the suggested status. */
  'inbox.resolve': proc<null>()(z.object({ id: z.number().int(), applicationId: z.number().int().nullable(), status: z.enum(APP_STATUSES).nullable().default(null) })),
  'inbox.dismiss': proc<null>()(Id),
}
