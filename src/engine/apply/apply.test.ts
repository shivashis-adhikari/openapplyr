import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeAts } from '../../../tools/fake-ats/server'
import type { PreparedAnswer, Profile, RunMode, RunStep } from '../../shared/domain'
import { resolveForm } from '../answers/resolve'
import { heuristicResume, toProfile } from '../profile/extract'
import { SAMPLE_RESUME, makePdf, testCtx, testServices } from '../test/harness'
import { MockLanguageModelV4 } from 'ai/test'
import { findForm } from './agent'
import { generic, greenhouse, lever } from './adapters'
import { ApplyContext, type UserReply } from './context'
import { readPage } from './form'

const base = toProfile(heuristicResume(SAMPLE_RESUME))
const profile: Profile = { ...base, jobSearch: { ...base.jobSearch, workAuthorization: [{ country: 'PT', authorized: true, needsSponsorship: false }] } }

let browser: Browser | null = null
let ats: Awaited<ReturnType<typeof startFakeAts>>
const dir = mkdtempSync(join(tmpdir(), 'openapplyr-apply-'))
const resume = join(dir, 'Maya_Okafor_Resume.pdf')
writeFileSync(resume, makePdf(['Maya Okafor', 'Senior Backend Engineer']))

beforeAll(async () => {
  ats = await startFakeAts()
  // Uses the installed Chrome, as the app does. CI images have it; skip where no browser exists.
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null)
}, 60_000) // a cold Chrome start on a busy CI runner can take well over the default 10 seconds
afterAll(async () => {
  await browser?.close()
  await ats.close()
}, 30_000)

async function context(url: string, mode: RunMode, replies: UserReply[] = [], prepared: PreparedAnswer[] = [], who: Profile = profile, model?: MockLanguageModelV4) {
  const ctx = testCtx()
  const s = testServices(ctx)
  if (model) {
    ctx.db.run("UPDATE providers SET kind = 'anthropic'")
    s.providers.model = () => model
  }
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
  const steps: RunStep[] = []
  const asked: string[] = []
  const job = { title: 'Senior Backend Engineer', company: 'Acme', companyId: null, country: 'PT', description: 'Go and PostgreSQL.' }
  const apply: ApplyContext = new ApplyContext({
    page,
    mode,
    job: { title: job.title, company: job.company, url },
    answers: prepared,
    resolve: async (q) => (await resolveForm([q], { profile: who, job, db: ctx.db, letterText: null, allowGenerated: true }, s.ai))[0]!,
    files: { resume, coverLetter: null },
    evidenceDir: mkdtempSync(join(dir, 'ev-')),
    signal: new AbortController().signal,
    onStep: (st) => steps.push(st),
    askUser: async (q) => {
      asked.push(q)
      return replies.shift() ?? { kind: 'stop' }
    },
    now: () => Date.now(),
    findForm: () => findForm(apply, s.ai),
  })
  return { apply, page, steps, asked }
}

describe.skipIf(!process.env.CI && !(await chromium.launch({ channel: 'chrome', headless: true }).then((b) => (b.close(), true)).catch(() => false)))('apply engine against local forms', () => {
  it('fills a Greenhouse-style form, including comboboxes and the upload, and submits once', async () => {
    const { apply, page, asked } = await context(`${ats.url}/greenhouse/jobs/1`, 'submit')
    const out = await greenhouse.run(apply)
    await page.close()
    expect(asked).toEqual([])
    expect(out).toMatchObject({ status: 'submitted' })
    expect(ats.submissions).toHaveLength(1)
    const sub = ats.submissions.at(-1)!
    expect(sub.fields).toMatchObject({ first_name: 'Maya', last_name: 'Okafor', email: 'maya.okafor@example.com', question_1: 'Yes', question_2: 'No', gender: "I don't wish to answer", privacy: 'on' })
    expect(sub.fields['question_3']).toContain('Northwind Payments')
    expect(sub.files).toEqual(['Maya_Okafor_Resume.pdf'])
    expect(apply.fields.get('question_1')).toMatchObject({ value: 'Yes', source: 'profile' })
  }, 60_000)

  it('stops before the final click in a dry run, with a screenshot and field record', async () => {
    const before = ats.submissions.length
    const { apply, page } = await context(`${ats.url}/greenhouse/jobs/1`, 'dry_run')
    const out = await greenhouse.run(apply)
    await page.close()
    expect(out).toMatchObject({ status: 'ready' })
    expect(ats.submissions.length).toBe(before)
    expect(apply.submitted).toBe(false)
  }, 60_000)

  it('handles radio cards, checkbox groups and a location that must be picked from a list', async () => {
    const withLanguages: Profile = { ...profile, languages: [{ name: 'English', fluency: 'Fluent' }, { name: 'Portuguese', fluency: 'Native' }] }
    const { apply, page, asked } = await context(`${ats.url}/lever/acme/1`, 'submit', [], [], withLanguages)
    const out = await lever.run(apply)
    await page.close()
    expect(asked).toEqual([])
    expect(out).toMatchObject({ status: 'submitted' })
    const sub = ats.submissions.at(-1)!
    expect(sub.fields).toMatchObject({ name: 'Maya Okafor', selectedLocation: 'Lisbon, PRT', 'cards[abc][field0]': 'No', 'cards[def][field0]': 'English; Portuguese' })
  }, 60_000)

  it('asks the user for a question nothing can answer, then carries on through the next step', async () => {
    const { apply, page, asked } = await context(`${ats.url}/wizard/1`, 'submit', [{ kind: 'answer', fieldName: 'colour', answer: 'Green' }])
    const out = await generic.run(apply)
    await page.close()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/favourite colour/)
    expect(out).toMatchObject({ status: 'submitted' })
    expect(ats.submissions.at(-1)!.fields).toMatchObject({ fn: 'Maya', em: 'maya.okafor@example.com', colour: 'Green' })
  }, 60_000)

  it('hands a CAPTCHA to the user, then finishes the form', async () => {
    const { apply, page, asked } = await context(`${ats.url}/captcha/1`, 'submit', [{ kind: 'continue' }])
    const out = await generic.run(apply)
    await page.close()
    expect(asked[0]).toMatch(/CAPTCHA/)
    expect(out).toMatchObject({ status: 'submitted' })
    expect(ats.submissions.at(-1)).toMatchObject({ form: 'captcha', fields: { fn: 'Maya', em: 'maya.okafor@example.com' } })
  }, 60_000)

  it('asks the user to sign in instead of typing into a login form', async () => {
    const { apply, page, asked, steps } = await context(`${ats.url}/login`, 'submit')
    await expect(generic.run(apply)).rejects.toThrow()
    await page.close()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/sign in or create an account/)
    expect(steps.filter((s) => s.kind === 'fill')).toEqual([])
  }, 60_000)

  it('refuses to press a submit button outside the submit gate', async () => {
    const { apply, page } = await context(`${ats.url}/greenhouse/jobs/1`, 'submit')
    await page.goto(`${ats.url}/greenhouse/jobs/1`)
    const s = await readPage(page.mainFrame())
    const submit = s.buttons.find((b) => /submit/i.test(b.text))!
    await expect(apply.click(page.locator(`[data-oa-button="${submit.id}"]`), 'x')).rejects.toThrow(/Refused/)
    await page.close()
  }, 30_000)

  it('lets the navigation agent reach a form behind an unfamiliar link, and never lets it submit', async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const text = JSON.stringify(prompt)
        const ref = /link \\"Start your application\\" \[ref=(e\d+)\]/.exec(text)?.[1]
        const onForm = /First name/.test(text.split('page accessibility snapshot').at(-1) ?? '')
        const call = onForm ? { toolName: 'form_ready', input: '{}' } : { toolName: 'click', input: JSON.stringify({ ref, why: 'Open the form' }) }
        return { content: [{ type: 'tool-call' as const, toolCallId: 't', ...call }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' }, usage, warnings: [] }
      },
    })
    const { apply, page, asked, steps } = await context(`${ats.url}/landing`, 'dry_run', [{ kind: 'answer', fieldName: 'colour', answer: 'Blue' }], [], profile, model)
    const out = await generic.run(apply)
    await page.close()
    expect(steps.some((st) => st.kind === 'agent' && /click/.test(st.text))).toBe(true)
    expect(asked.filter((q) => /Open the application form/.test(q))).toEqual([])
    expect(out).toMatchObject({ status: 'ready' })
  }, 60_000)
})
