import { z } from 'zod'
import { type Profile, ProfileSchema } from '../domain'
import { proc } from './define'

export type ImportMethod = 'linkedin-export' | 'json-resume' | 'model'

export type ImportResult = {
  draft: Profile
  sourceText: string
  method: ImportMethod
  /** Extracted strings that could not be found in the source; shown for the user to check. */
  unverified: { path: string; text: string }[]
  warnings: string[]
}

export type CompletenessItem = { key: string; label: string; done: boolean; why: string }

export type ProfileState = {
  profile: Profile
  updatedAt: number | null
  completeness: CompletenessItem[]
  yearsOfExperience: number
}

export type Voice = { description: string; samples: string[] }

export const profileApi = {
  'profile.get': proc<ProfileState>()(z.void()),
  'profile.save': proc<ProfileState>()(z.object({ profile: ProfileSchema, sourceText: z.string().max(400_000).optional() })),
  'profile.import': proc<ImportResult>()(
    z.union([z.object({ path: z.string().min(1) }), z.object({ text: z.string().min(40, 'Paste the whole resume.').max(200_000) })]),
  ),
  'profile.voice': proc<Voice>()(z.void()),
  'profile.saveVoice': proc<Voice>()(z.object({ description: z.string().max(2000), samples: z.array(z.string().max(8000)).max(5) })),
  'profile.describeVoice': proc<Voice>()(z.object({ samples: z.array(z.string().min(40).max(8000)).min(1).max(5) })),
}
