import { createHash } from 'node:crypto'
import { z } from 'zod'
import { block, definePrompt, untrusted } from '../ai/prompt'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import type { Services } from '../services'
import { boardKey, detectAts } from '../sources/detect'
import { pollSource } from '../sources/poller'
import { addBoard } from '../sources/registry'
import { ATS_KINDS, type AtsKind } from '../sources/types'
import { htmlToText } from '../util/html'
import { ingest } from './ingest'

const Extracted = z.object({
  isJobPosting: z.boolean(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  employmentType: z.string(),
  salaryText: z.string(),
  applyUrl: z.string(),
  descriptionStartsWith: z.string().describe('The first 8 to 15 words of the job description, copied exactly'),
  descriptionEndsWith: z.string().describe('The last 8 to 15 words of the job description, copied exactly'),
})
type Extracted = z.infer<typeof Extracted>

export const extractJobPrompt = definePrompt<{ text: string; url: string | null }, Extracted>({
  id: 'jobs.extract',
  version: 1,
  role: 'fast',
  system: 'You read a web page or pasted text and pull out the job posting in it, so it can be tracked and applied to. Report only what the text states.',
  describe: 'The job posting fields.',
  maxOutputTokens: 800,
  user: ({ text, url }) =>
    [
      untrusted(url ?? 'pasted text', text),
      block(
        'instructions',
        [
          'Find the single job posting in the text above.',
          '- isJobPosting: false when the text is a login page, a list of many jobs, an error page, or not a job posting.',
          '- Copy title, company and location as written. Leave a field empty when it is not stated.',
          '- applyUrl: an application link that appears in the text, or empty.',
          '- descriptionStartsWith / descriptionEndsWith: copy the first and last 8 to 15 words of the posting body exactly, so the body can be cut out of the page.',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: Extracted,
  mock: ({ text }) => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const find = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]?.trim()).find(Boolean) ?? ''
    const title = find(/^(?:title|position|role)\s*:\s*(.+)$/i) || lines[0] || ''
    const company = find(/^(?:company|employer)\s*:\s*(.+)$/i) || find(/\bat\s+([A-Z][\w&.\- ]+)$/) || ''
    const bodyWords = text.replace(/\s+/g, ' ').trim().split(' ')
    return {
      isJobPosting: lines.length >= 3 && !/(sign in|log in) to (continue|view)/i.test(text),
      title,
      company,
      location: find(/^location\s*:\s*(.+)$/i),
      employmentType: find(/^(?:type|employment type)\s*:\s*(.+)$/i),
      salaryText: find(/^(?:salary|compensation|pay)\s*:\s*(.+)$/i),
      applyUrl: '',
      descriptionStartsWith: bodyWords.slice(0, 10).join(' '),
      descriptionEndsWith: bodyWords.slice(-10).join(' '),
    }
  },
})

/** Cuts the posting body out of page text using quoted start and end phrases; falls back to the whole text. */
export function sliceBody(text: string, start: string, end: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const s = start.trim() ? flat.indexOf(start.replace(/\s+/g, ' ').trim()) : -1
  const e = end.trim() ? flat.lastIndexOf(end.replace(/\s+/g, ' ').trim()) : -1
  if (s >= 0 && e >= s) return flat.slice(s, e + end.replace(/\s+/g, ' ').trim().length)
  return flat.slice(0, 20_000)
}

function matchPosted(ctx: Ctx, sourceId: number, ats: string, jobId: string | null): number | null {
  if (!jobId) return null
  const rows = ctx.db.all<{ id: number; external_id: string; url: string }>('SELECT id, external_id, url FROM jobs WHERE source_id = ?', [sourceId])
  const hit = rows.find((r) => r.external_id === jobId || r.url.includes(jobId) || (ats === 'workday' && `/${jobId}`.endsWith(r.external_id)))
  return hit?.id ?? null
}

async function fromText(ctx: Ctx, s: Services, text: string, url: string | null): Promise<number> {
  const clipped = text.slice(0, 40_000)
  const x = await s.ai.structured(extractJobPrompt, { text: clipped, url }, { task: 'Read job posting' })
  if (!x.isJobPosting || !x.title) {
    throw new AppError('NOT_A_JOB', url ? 'That page does not show a single job posting (it may need a login). Paste the job text instead.' : 'That text does not look like a job posting.', { permanent: true })
  }
  const body = sliceBody(clipped, x.descriptionStartsWith, x.descriptionEndsWith)
  const externalId = createHash('sha1').update(url ?? `${x.company}|${x.title}|${body.slice(0, 500)}`).digest('hex').slice(0, 20)
  const res = ingest(
    ctx.db,
    { id: 0, kind: 'manual' },
    {
      complete: false,
      postings: [
        {
          externalId,
          title: x.title,
          company: x.company || 'Unknown company',
          url: url ?? `manual:${externalId}`,
          applyUrl: /^https?:\/\//.test(x.applyUrl) ? x.applyUrl : (url ?? undefined),
          locationText: x.location,
          descriptionText: `${body}${x.salaryText && !body.includes(x.salaryText) ? `\n\nSalary: ${x.salaryText}` : ''}`,
          employmentHint: x.employmentType,
          postedAt: ctx.now(),
          meta: { imported: true },
        },
      ],
    },
    ctx.now(),
  )
  const id = res.inserted[0] ?? res.updated[0] ?? ctx.db.get<{ id: number }>("SELECT id FROM jobs WHERE source_kind = 'manual' AND external_id = ?", [externalId])?.id
  if (!id) throw new AppError('IMPORT_FAILED', 'The job could not be saved.', { permanent: true })
  ctx.db.run("UPDATE jobs SET user_state = 'saved' WHERE id = ?", [id])
  return id
}

/** Imports one job from a link. Known ATS boards are fetched through their API; other pages are read. */
export async function importUrl(ctx: Ctx, s: Services, url: string): Promise<number> {
  const d = detectAts(url)
  if (d?.board && (ATS_KINDS as readonly string[]).includes(d.ats)) {
    const sourceId = addBoard(ctx, d.ats as AtsKind, d.board, { origin: 'import' })
    await pollSource(ctx, sourceId)
    const id = matchPosted(ctx, sourceId, d.ats, d.jobId)
    if (id) {
      ctx.db.run("UPDATE jobs SET user_state = 'saved' WHERE id = ? AND user_state IS NULL", [id])
      return id
    }
    if (d.jobId) throw new AppError('NOT_LISTED', `That job is not on ${boardKey(d.ats, d.board)}'s board anymore. It may be closed.`, { permanent: true })
  }
  if (d && ['linkedin', 'indeed', 'wellfound'].includes(d.ats)) {
    throw new AppError('NEEDS_LOGIN', `${d.ats[0]!.toUpperCase()}${d.ats.slice(1)} pages need a login to read. Open the job, copy its text, and use Paste text.`, { permanent: true })
  }
  const page = await ctx.http.getText(url, { as: 'page', timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 })
  const text = htmlToText(page.text)
  if (text.length < 200) throw new AppError('NOT_A_JOB', 'That page has almost no text (it may load with scripts or need a login). Paste the job text instead.', { permanent: true })
  return fromText(ctx, s, text, page.url)
}

export function importText(ctx: Ctx, s: Services, text: string, url: string | null): Promise<number> {
  return fromText(ctx, s, text, url)
}
