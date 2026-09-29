import type { Frame, Page } from 'playwright-core'
import { fold } from '../util/text'
import { type ApplyContext, SUBMIT_TEXT, StoppedByUser } from './context'
import { type PageButton, type PageField, type PageState, chooseOption, fillField, readPage, toQuestion } from './form'

export type RunOutcome =
  | { status: 'submitted'; confirmation: { text: string; url: string } }
  | { status: 'unverified'; note: string }
  | { status: 'ready'; note: string }
  | { status: 'failed'; error: string }

const NEXT_TEXT = /^(next|continue|save (and|&) continue|review( (my )?application)?|proceed)\b/i
export const DONE_TEXT =
  /thank(s| you)\b.{0,80}\b(appl|interest|submi)|application (has been |was )?(submitted|received|sent|completed?)\b|we('ve| have) (successfully )?received your application|successfully (submitted|applied)|your application is (in|on its way)|application submitted/i
const DONE_URL = /(confirmation|thank-?you|thanks|success|submitted|applied)\b/i

export function findSubmit(s: PageState): PageButton | null {
  const candidates = s.buttons.filter((b) => SUBMIT_TEXT.test(b.text) && !NEXT_TEXT.test(b.text))
  return candidates.find((b) => b.type === 'submit' && /submit|send/i.test(b.text)) ?? candidates.find((b) => /submit|send/i.test(b.text)) ?? candidates.at(-1) ?? null
}

export const findNext = (s: PageState): PageButton | null => s.buttons.find((b) => NEXT_TEXT.test(b.text)) ?? null

export function looksDone(s: PageState, formUrl: string): boolean {
  const formGone = s.fields.filter((f) => f.kind !== 'file').length === 0
  if (DONE_TEXT.test(s.text) && (formGone || !findSubmit(s))) return true
  return s.url !== formUrl && DONE_URL.test(new URL(s.url).pathname) && formGone
}

/** Waits for the page to stop changing (client-side apps render their forms after load). */
export async function settle(page: Page, frame: Frame): Promise<PageState> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  let state = await readPage(frame)
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(400)
    const next = await readPage(frame)
    if (next.fields.length === state.fields.length && next.buttons.length === state.buttons.length) return next
    state = next
  }
  return state
}

const sameValue = (f: PageField, answer: string) => {
  if (!f.value) return false
  if (f.kind === 'text' || f.kind === 'textarea' || f.kind === 'number' || f.kind === 'date') return fold(f.value) === fold(answer)
  if (f.kind === 'checkbox') return /^yes$/i.test(f.value) === /^(yes|true|i agree|i accept|checked)/i.test(answer)
  const pick = chooseOption(f.options.length ? f.options : [f.value], answer)
  return !!pick && fold(pick) === fold(f.value)
}

/** Fills every field on the current page. Returns the required fields it could not fill. */
export async function fillPage(ctx: ApplyContext, frame: Frame, state: PageState): Promise<{ field: PageField; note: string }[]> {
  const unresolved: { field: PageField; note: string }[] = []
  for (const f of state.fields) {
    ctx.checkStopped()
    const q = toQuestion(f)
    const a = await ctx.answerFor(q)
    let answer = a.answer
    if (f.kind === 'file') {
      answer = /cover/i.test(f.label) ? 'cover_letter' : /resume|cv\b|curriculum/i.test(f.label) ? 'resume' : a.answer || (f.required ? 'resume' : '')
      if (answer === 'cover_letter' && !ctx.files.coverLetter) {
        if (f.required) unresolved.push({ field: f, note: 'This form requires a cover letter file.' })
        continue
      }
    }
    if (!answer) {
      if (f.required && !f.value) unresolved.push({ field: f, note: a.needsUser ? 'Needs your answer.' : 'No saved answer.' })
      continue
    }
    if (f.kind !== 'file' && sameValue(f, answer)) {
      ctx.record(f, f.value, a.source)
      continue
    }
    try {
      const r = await fillField(frame, f, answer, ctx.files)
      if (r.ok) {
        ctx.record(f, r.value, f.kind === 'file' ? 'file' : a.source)
        ctx.step(f.kind === 'file' ? 'upload' : 'fill', `${f.label}: ${f.kind === 'file' ? r.value : r.value.slice(0, 80)}`)
      } else if (f.required) unresolved.push({ field: f, note: r.note ?? 'Could not fill this field.' })
    } catch (err) {
      if (err instanceof StoppedByUser) throw err
      if (f.required) unresolved.push({ field: f, note: `Could not fill this field (${String(err).split('\n')[0]!.slice(0, 120)}).` })
    }
  }
  return unresolved
}

async function waitForChange(page: Page, before: string): Promise<void> {
  await Promise.race([page.waitForURL((u) => u.toString() !== before, { timeout: 10_000 }), page.waitForTimeout(2500)]).catch(() => undefined)
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
}

async function handleChallenge(ctx: ApplyContext): Promise<void> {
  const reply = await ctx.askUser(`${ctx.job.company} shows a CAPTCHA. Solve it in the browser window, then press Continue.`, 'challenge')
  if (reply.kind === 'stop') throw new StoppedByUser()
}

/** After the click: waits for a confirmation, a validation error, or a challenge. */
async function confirmation(ctx: ApplyContext, getFrame: () => Frame, formUrl: string): Promise<RunOutcome> {
  const deadline = Date.now() + 30_000
  let lastErrors: string[] = []
  while (Date.now() < deadline) {
    await ctx.page.waitForTimeout(1000)
    let state: PageState
    try {
      state = await readPage(getFrame())
    } catch {
      continue // navigating
    }
    if (looksDone(state, formUrl)) {
      await ctx.screenshot('after-submit')
      const text = (DONE_TEXT.exec(state.text)?.[0] ?? state.title).slice(0, 300)
      return { status: 'submitted', confirmation: { text, url: state.url } }
    }
    if (state.challenge) await handleChallenge(ctx)
    lastErrors = state.errors
  }
  await ctx.screenshot('after-submit')
  if (lastErrors.length) return { status: 'failed', error: `The form reported: ${lastErrors.slice(0, 3).join('; ')}` }
  return { status: 'unverified', note: 'The form was sent, but no confirmation appeared. Check the screenshot, or wait for the confirmation email.' }
}

export type RunFormOptions = {
  getFrame: () => Frame
  maxPages?: number
  submitButton?: (s: PageState) => PageButton | null
}

/**
 * The generic form flow used by every adapter: read, fill, ask for what is missing, Next, repeat,
 * then the submit gate. Choice fields only receive their own options; nothing is guessed.
 */
export async function runForm(ctx: ApplyContext, o: RunFormOptions): Promise<RunOutcome> {
  const maxPages = o.maxPages ?? 10
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    ctx.checkStopped()
    const frame = o.getFrame()
    const formUrl = ctx.page.url()
    let state = await settle(ctx.page, frame)
    if (state.challenge) {
      await handleChallenge(ctx)
      state = await settle(ctx.page, frame)
    }
    // Credentials are the person's to type; never fill a sign-in or sign-up form.
    if (state.login) {
      const reply = await ctx.askUser(`${ctx.job.company} asks you to sign in or create an account. Do that in the browser window, then press Continue.`, 'challenge')
      if (reply.kind === 'stop') throw new StoppedByUser()
      continue
    }
    if (pageNo > 1 && looksDone(state, formUrl)) return { status: 'submitted', confirmation: { text: DONE_TEXT.exec(state.text)?.[0] ?? state.title, url: state.url } }
    if (!state.fields.length && !findSubmit(state) && !findNext(state)) return { status: 'failed', error: 'No application form was found on this page.' }

    for (let pass = 0; pass < 4; pass++) {
      const unresolved = await fillPage(ctx, frame, state)
      if (!unresolved.length) break
      for (const { field, note } of unresolved) {
        const reply = await ctx.askUser(`${ctx.job.company} asks: ${field.label}${field.options.length ? ` (${field.options.slice(0, 8).join(', ')})` : ''}. ${note}`, 'answer', { name: field.name || field.label, label: field.label })
        if (reply.kind === 'stop') throw new StoppedByUser()
        if (reply.kind === 'answer') ctx.remember(field.name || field.label, field.label, reply.answer)
      }
      state = await readPage(frame)
      if (pass === 3) return { status: 'failed', error: 'Some required questions could not be filled.' }
    }

    // Some forms re-render and drop values (late hydration); refill anything that went missing once.
    const check = await readPage(frame)
    const lost = check.fields.filter((f) => f.required && !f.value && f.kind !== 'file' && ctx.fields.has(f.name || f.label))
    if (lost.length) {
      ctx.step('info', `Refilling ${lost.length} field${lost.length === 1 ? '' : 's'} the page cleared.`)
      await fillPage(ctx, frame, { ...check, fields: lost })
    }

    const final = await readPage(frame)
    const submit = o.submitButton?.(final) ?? findSubmit(final)
    const next = findNext(final)
    if (next && !submit) {
      const before = ctx.page.url()
      await ctx.click(frame.locator(`[data-oa-button="${next.id}"]`).first(), `Next: ${next.text}`)
      await waitForChange(ctx.page, before)
      continue
    }
    if (!submit) {
      const reply = await ctx.askUser(`OpenApplyr could not find the button that sends the application at ${ctx.job.company}. Get the form to its last step in the browser window, then press Continue.`, 'unexpected')
      if (reply.kind === 'stop') throw new StoppedByUser()
      continue
    }
    const clicked = await ctx.submit(frame.locator(`[data-oa-button="${submit.id}"]`).first())
    if (!clicked) return { status: 'ready', note: ctx.mode === 'dry_run' ? 'Dry run finished before the final click.' : 'Filled and waiting for you to submit.' }
    return confirmation(ctx, o.getFrame, formUrl)
  }
  return { status: 'failed', error: `The application had more than ${maxPages} steps.` }
}
