import mammoth from 'mammoth'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { TEMPLATES } from '../../../templates/resume'
import { heuristicJudgment } from '../match/judge'
import { heuristicResume, toProfile } from '../profile/extract'
import { SAMPLE_RESUME, testCtx, testServices } from '../test/harness'
import { factLock } from './factlock'
import { keywordCoverage, writeLetter } from './letter'
import { resumeDocx, resumeTxt } from './render'
import { extrasFor } from './store'
import { styleCheck } from './styleguard'
import { baseContent, buildContent, tailorResume } from './tailor'

const profile = toProfile(heuristicResume(SAMPLE_RESUME))
const job = {
  title: 'Senior Backend Engineer',
  company: 'Tidewater',
  description: '## Requirements\n- 5+ years building backend services\n- Go and PostgreSQL in production\n- Kafka\n- Terraform on AWS',
}
const judgment = heuristicJudgment({ profile, ...job, location: 'Lisbon', wantedTitles: ['Backend Engineer'] })

describe('tailoring', () => {
  it('builds a resume from profile facts that passes fact-lock (offline model)', async () => {
    const ctx = testCtx()
    const s = testServices(ctx)
    const r = await tailorResume(s.ai, { profile, job, judgment, maxPages: 1 })
    expect(r.issues).toEqual([])
    expect(r.retried).toBe(false)
    expect(r.content.work.map((w) => w.company)).toEqual(['Northwind Payments', 'Tidewater Analytics'])
    expect(r.content.skills.slice(0, 2)).toEqual(expect.arrayContaining(['Go']))
  })

  it('retries when the model invents a metric, then reverts whatever still fails', async () => {
    const ctx = testCtx()
    const s = testServices(ctx)
    ctx.db.run("UPDATE providers SET kind = 'anthropic'")
    const w0 = profile.work[0]!
    const bad = {
      headline: 'Principal Engineer',
      summary: { text: 'Backend engineer with 9 years in Go.', factIds: [] },
      work: [{ workId: w0.id, bullets: [{ sourceIds: [w0.bullets[0]!.id], text: 'Cut settlement batch time by 95% using Rust workers' }] }],
      projects: [],
      skills: ['Go', 'Rust'],
    }
    let calls = 0
    s.providers.model = () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls++
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(bad) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            warnings: [],
          }
        },
      })
    const r = await tailorResume(s.ai, { profile, job, judgment, maxPages: 1 })
    expect(calls).toBe(2)
    expect(r.retried).toBe(true)
    expect(r.issues).toEqual([])
    const line = r.content.work[0]!.bullets[0]!
    expect(line.text).toBe(w0.bullets[0]!.text)
    expect(line.flagged).toMatch(/Reverted/)
    expect(r.content.skills).not.toContain('Rust')
    // A title the person never held is replaced with a real one.
    expect(r.content.headline).not.toBe('Principal Engineer')
    // The older role the model left out is still on the resume.
    expect(r.content.work.map((w) => w.company)).toContain('Tidewater Analytics')
  })

  it('base content includes every fact and passes fact-lock', () => {
    const c = baseContent(profile)
    expect(c.work.flatMap((w) => w.bullets)).toHaveLength(5)
    expect(factLock(c, profile)).toEqual([])
    expect(buildContent(profile, { headline: 'x', summary: { text: '', factIds: [] }, work: [], projects: [], skills: [] }).work).toHaveLength(2)
  })
})

describe('templates', () => {
  const content = { ...baseContent(profile), name: 'Maya <script>alert(1)</script> Okafor' }
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s renders escaped, self-contained HTML', (_id, t) => {
    const html = t.render({ content, pageSize: 'Letter', fontsDir: 'assets/fonts', extras: { noticePeriod: '30 days' } })
    expect(html).toContain('Maya &lt;script&gt;')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).toContain('Northwind Payments')
    expect(html).toContain('Cut settlement batch time')
  })
})

describe('other formats and checks', () => {
  it('writes a DOCX that Word-compatible parsers read in order', async () => {
    const buf = await resumeDocx(baseContent(profile), 'A4')
    const text = (await mammoth.extractRawText({ buffer: buf })).value
    expect(text.indexOf('Northwind Payments')).toBeLessThan(text.indexOf('Tidewater Analytics'))
    expect(text).toContain('Led a team of 5 engineers')
    expect(resumeTxt(baseContent(profile))).toMatch(/^Maya Okafor/)
  })

  it('splits posting keywords into present, in profile but missing, and not in profile', () => {
    const k = keywordCoverage(job.description, [], { ...baseContent(profile), skills: ['Go'] }, profile)
    expect(k.present).toEqual(expect.arrayContaining(['Go', 'PostgreSQL']))
    expect(k.inProfileNotResume).toContain('Terraform')
    expect(k.notInProfile).toEqual([])
  })

  it('writes a cover letter that passes the style guard (offline model)', async () => {
    const ctx = testCtx()
    const s = testServices(ctx)
    const r = await writeLetter(s.ai, { profile, job, judgment, voice: '', region: 'US' })
    expect(r.issues).toEqual([])
    expect(r.text).toMatch(/^Dear Hiring Manager,/)
    expect(r.text).toContain('Northwind Payments')
    expect(styleCheck(r.text, 'letter')).toEqual([])
  })
})

describe('work authorization line', () => {
  const withAuth = (auth: { country: string; authorized: boolean; needsSponsorship: boolean }[]) => extrasFor({ ...profile, jobSearch: { ...profile.jobSearch, workAuthorization: auth } }).workAuthorization
  it('reads as one sentence, with sponsorship needs after it', () => {
    expect(withAuth([{ country: 'PT', authorized: true, needsSponsorship: false }])).toBe('Authorized to work in Portugal')
    expect(withAuth(['PT', 'NL', 'DE'].map((country) => ({ country, authorized: true, needsSponsorship: false })))).toBe('Authorized to work in Portugal, Netherlands and Germany')
    expect(
      withAuth([
        { country: 'GB', authorized: true, needsSponsorship: false },
        { country: 'US', authorized: true, needsSponsorship: true },
        { country: 'FR', authorized: false, needsSponsorship: false },
      ]),
    ).toBe('Authorized to work in United Kingdom. Needs visa sponsorship in United States')
    expect(withAuth([])).toBeUndefined()
  })
})
