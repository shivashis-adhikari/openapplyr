import { z } from 'zod'
import type { StyleIssue } from '../domain'
import { proc } from './define'

export const PURPOSES = ['recruiter_intro', 'hiring_manager', 'referral', 'follow_up', 'thank_you', 'linkedin_note', 'linkedin_message'] as const
export type ContactInfo = {
  id: number
  name: string
  title: string | null
  relation: string
  email: string | null
  emailStatus: string
  linkedinUrl: string | null
  company: string | null
  source: string
  confidence: number
  doNotContact: boolean
  lastContactedAt: number | null
  notes: string
}
export type OutreachItem = {
  id: number
  threadKey: string | null
  applicationId: number | null
  contact: { id: number; name: string; title: string | null; email: string | null; emailStatus: string }
  company: string | null
  jobTitle: string | null
  channel: string
  step: number
  purpose: string
  subject: string | null
  body: string
  attachResume: boolean
  status: 'draft' | 'scheduled' | 'sent' | 'cancelled' | 'failed'
  scheduledAt: number | null
  sentAt: number | null
  error: string | null
}

const Id = z.object({ id: z.number().int() })
const Ids = z.object({ ids: z.array(z.number().int()).min(1).max(500) })

export const outreachApi = {
  'contacts.list': proc<ContactInfo[]>()(z.object({ q: z.string().max(200).default(''), applicationId: z.number().int().nullable().default(null) })),
  'contacts.save': proc<ContactInfo>()(
    z.object({
      id: z.number().int().optional(),
      name: z.string().trim().min(1, 'Enter a name.').max(200),
      title: z.string().max(200).nullable().default(null),
      email: z.string().trim().email('That email address does not look right.').nullable().default(null),
      linkedinUrl: z.string().url().nullable().default(null),
      company: z.string().max(200).nullable().default(null),
      notes: z.string().max(10_000).default(''),
    }),
  ),
  'contacts.delete': proc<null>()(Id),
  'contacts.setDoNotContact': proc<null>()(z.object({ id: z.number().int(), value: z.boolean() })),
  'contacts.discover': proc<ContactInfo[]>()(z.object({ applicationId: z.number().int() })),

  'outreach.list': proc<OutreachItem[]>()(z.object({ filter: z.enum(['drafts', 'scheduled', 'sent', 'all']).default('drafts'), applicationId: z.number().int().nullable().default(null) })),
  'outreach.draft': proc<{ item: OutreachItem; issues: StyleIssue[] }>()(
    z.object({ applicationId: z.number().int(), contactId: z.number().int(), purpose: z.enum(PURPOSES), notes: z.string().max(10_000).optional() }),
  ),
  'outreach.update': proc<OutreachItem>()(z.object({ id: z.number().int(), subject: z.string().max(200).optional(), body: z.string().min(1).max(10_000).optional(), attachResume: z.boolean().optional() })),
  'outreach.approve': proc<{ scheduled: number }>()(Ids),
  'outreach.cancel': proc<null>()(Ids),
  'outreach.sendNow': proc<null>()(Id),
}
