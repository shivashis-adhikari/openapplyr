import { z } from 'zod'
import type { ImportResult, Voice } from '../../shared/api/profile'
import { block, definePrompt, untrusted } from '../ai/prompt'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import type { Services } from '../services'
import { extractProfilePrompt, toProfile, unverifiedStrings } from './extract'
import { fromJsonResume, fromLinkedInZip } from './formats'
import { documentText, kindOf, readBytes } from './read'
import { loadVoice, profileState, saveProfile } from './store'

export const describeVoicePrompt = definePrompt<{ samples: string[] }, { description: string }>({
  id: 'profile.voice',
  version: 1,
  role: 'writer',
  system: 'You describe how a person writes so that drafts written for them sound like them. Be concrete; avoid adjectives like "professional" that say nothing.',
  describe: 'A short writing-style description.',
  maxOutputTokens: 600,
  user: ({ samples }) =>
    [
      ...samples.map((s, i) => untrusted(`writing sample ${i + 1}`, s)),
      block(
        'instructions',
        'Describe this person\'s writing in 4 to 6 short lines covering: typical sentence length, formality, use of contractions, how they open and sign off emails, ' +
          'words or phrases they use often, and anything they avoid. Write it as instructions to someone drafting for them, for example "Short sentences. Uses contractions."',
      ),
    ].join('\n\n'),
  schema: z.object({ description: z.string().min(10).max(1200) }),
  mock: ({ samples }) => {
    const text = samples.join(' ')
    const sentences = text.split(/[.!?]+\s/).filter(Boolean)
    const avg = Math.round(text.split(/\s+/).length / Math.max(1, sentences.length))
    const contractions = /\b\w+'(s|re|ll|ve|d|t)\b/i.test(text)
    return {
      description: [
        avg <= 14 ? 'Short, direct sentences.' : 'Medium-length sentences.',
        contractions ? 'Uses contractions.' : 'Avoids contractions.',
        /^(hi|hey)\b/im.test(text) ? 'Opens with "Hi" and the first name.' : 'Opens with "Hello" and the first name.',
        'Signs off with the first name only.',
      ].join('\n'),
    }
  },
})

export function registerProfileHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx

  router.on('profile.get', () => profileState(db))

  router.on('profile.save', ({ profile, sourceText }) => {
    saveProfile(db, profile, sourceText, ctx.now())
    ctx.bus.changed('profile')
    return profileState(db)
  })

  router.on('profile.import', async (input): Promise<ImportResult> => {
    if ('path' in input) {
      const kind = kindOf(input.path)
      if (kind === 'zip') {
        const { profile, sourceText } = fromLinkedInZip(await readBytes(input.path))
        return { draft: profile, sourceText, method: 'linkedin-export', unverified: [], warnings: profile.work.length ? [] : ['The export has no positions. Add your roles by hand or import a resume.'] }
      }
      if (kind === 'json') {
        let doc: unknown
        try {
          doc = JSON.parse((await readBytes(input.path)).toString('utf8'))
        } catch {
          throw new AppError('BAD_JSON', 'That JSON file could not be read. Is it a JSON Resume file?', { permanent: true })
        }
        const profile = fromJsonResume(doc)
        return { draft: profile, sourceText: JSON.stringify(doc, null, 2), method: 'json-resume', unverified: [], warnings: [] }
      }
      return extract(await documentText(input.path))
    }
    return extract(input.text)
  })

  async function extract(text: string): Promise<ImportResult> {
    const clipped = text.length > 60_000 ? text.slice(0, 60_000) : text
    const extracted = await s.ai.structured(extractProfilePrompt, { text: clipped }, { task: 'Read resume' })
    const draft = toProfile(extracted)
    const warnings: string[] = []
    if (text.length > 60_000) warnings.push('The document is very long; only the first 60,000 characters were read.')
    if (draft.work.length === 0) warnings.push('No roles were found. Check the Experience section, or add roles by hand.')
    return { draft, sourceText: text, method: 'model', unverified: unverifiedStrings(draft, text), warnings }
  }

  const voice = (): Voice => loadVoice(db)
  const saveVoice = (v: Voice): Voice => {
    db.run(
      `INSERT INTO voice (id, description, samples, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description, samples = excluded.samples, updated_at = excluded.updated_at`,
      [v.description, JSON.stringify(v.samples), ctx.now()],
    )
    ctx.bus.changed('profile')
    return voice()
  }
  router.on('profile.voice', voice)
  router.on('profile.saveVoice', (v) => saveVoice(v))
  router.on('profile.describeVoice', async ({ samples }) => {
    const { description } = await s.ai.structured(describeVoicePrompt, { samples }, { task: 'Describe writing voice' })
    return saveVoice({ description, samples })
  })
}
