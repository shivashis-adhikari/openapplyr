import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import type { AnswerSource, PreparedAnswer, RunMode, RunStep } from '../../shared/domain'
import type { FormQuestion } from '../answers/questions'
import { questionKey } from '../answers/resolve'
import { fold } from '../util/text'
import type { PageField } from './form'

/** Words on a control that sends the application. Only ApplyContext.submit may click one. */
export const SUBMIT_TEXT = /^(submit|send|apply|finish|complete)\b.{0,30}$|^(submit|send) (my )?application$|^apply (now|for this (job|role|position))$/i

export type RunFiles = { resume: string; coverLetter: string | null }
export type FieldRecord = { label: string; value: string; source: AnswerSource | 'file'; kind: string }

/** The user's side of a paused run: an answer for a question, or "I handled it in the browser". */
export type UserReply = { kind: 'answer'; fieldName: string; answer: string } | { kind: 'continue' } | { kind: 'stop' }

export class StoppedByUser extends Error {
  constructor() {
    super('Stopped.')
    this.name = 'StoppedByUser'
  }
}

export type ApplyContextInit = {
  page: Page
  mode: RunMode
  job: { title: string; company: string; url: string }
  answers: PreparedAnswer[]
  resolve: (q: FormQuestion) => Promise<PreparedAnswer>
  files: RunFiles
  evidenceDir: string
  signal: AbortSignal
  onStep: (step: RunStep) => void
  askUser: (question: string, kind: 'answer' | 'challenge' | 'unexpected', field?: { name: string; label: string }) => Promise<UserReply>
  now: () => number
  /** Model-driven navigation to a form the runner cannot find (agent.ts). */
  findForm?: () => Promise<boolean>
}

/**
 * Everything an adapter may do. The only way to press a submit control is `submit()`, which applies the
 * run mode (dry run and assisted runs stop there) and records evidence first.
 */
export class ApplyContext {
  readonly page: Page
  readonly mode: RunMode
  readonly job: ApplyContextInit['job']
  readonly files: RunFiles
  readonly signal: AbortSignal
  readonly fields = new Map<string, FieldRecord>()
  submitted = false
  private readonly answers: PreparedAnswer[]

  constructor(private readonly o: ApplyContextInit) {
    this.page = o.page
    this.mode = o.mode
    this.job = o.job
    this.files = o.files
    this.signal = o.signal
    this.answers = o.answers
    mkdirSync(o.evidenceDir, { recursive: true })
  }

  step(kind: RunStep['kind'], text: string): void {
    this.o.onStep({ at: this.o.now(), kind, text })
  }

  checkStopped(): void {
    if (this.signal.aborted) throw new StoppedByUser()
  }

  /** The prepared answer for a field (matched by field name, then by question), or a fresh resolution. */
  async answerFor(q: FormQuestion): Promise<PreparedAnswer> {
    const byName = this.answers.find((a) => a.fieldName === q.fieldName && fold(a.question) === fold(q.label))
    const byLabel = this.answers.find((a) => fold(a.question) === fold(q.label) || (a.key !== null && a.key === questionKey(q.label)))
    const hit = byName ?? byLabel ?? this.answers.find((a) => a.fieldName === q.fieldName)
    if (hit && (hit.answer || !hit.needsUser)) return { ...hit, fieldName: q.fieldName, options: q.options }
    const fresh = await this.o.resolve(q)
    this.answers.push(fresh)
    return fresh
  }

  /** Records a user's answer given mid-run so the next pass over the page uses it. */
  remember(fieldName: string, question: string, answer: string): void {
    const existing = this.answers.find((a) => a.fieldName === fieldName)
    if (existing) Object.assign(existing, { answer, source: 'user', needsUser: false, confidence: 1 })
    else this.answers.push({ fieldName, question, key: null, kind: 'fact', required: true, options: [], answer, source: 'user', confidence: 1, needsUser: false })
  }

  /** Asks the navigation agent to reach the form; false when there is no agent or it gave up. */
  findForm(): Promise<boolean> {
    return this.o.findForm ? this.o.findForm() : Promise.resolve(false)
  }

  askUser(question: string, kind: 'answer' | 'challenge' | 'unexpected', field?: { name: string; label: string }): Promise<UserReply> {
    this.step('ask', question)
    return this.o.askUser(question, kind, field)
  }

  record(f: PageField, value: string, source: FieldRecord['source']): void {
    this.fields.set(f.name || f.label, { label: f.label, value, source, kind: f.kind })
  }

  /** Clicks a button that does not send the application (Next, Apply to open the form, Upload). */
  async click(button: Locator, what: string): Promise<void> {
    const text = ((await button.innerText().catch(() => '')) || (await button.getAttribute('value')) || '').trim()
    if (SUBMIT_TEXT.test(text) && !/^apply$/i.test(text)) throw new Error(`Refused to click "${text}" outside the submit step.`)
    this.step('click', what)
    await button.click()
  }

  async screenshot(name: string): Promise<string> {
    const path = join(this.o.evidenceDir, `${name}.jpg`)
    await this.page.screenshot({ path, type: 'jpeg', quality: 70, fullPage: true }).catch(() => this.page.screenshot({ path, type: 'jpeg', quality: 70 }))
    this.step('evidence', `Saved ${name}.jpg`)
    return path
  }

  /** Writes fields.json and copies the uploaded files, with hashes, into the evidence folder. */
  writeEvidence(): void {
    const files = [this.files.resume, this.files.coverLetter].filter((f): f is string => !!f)
    const uploaded = files.map((f) => {
      const dest = join(this.o.evidenceDir, basename(f))
      if (dest !== f) copyFileSync(f, dest)
      return { name: basename(f), sha256: createHash('sha256').update(readFileSync(f)).digest('hex') }
    })
    writeFileSync(join(this.o.evidenceDir, 'fields.json'), JSON.stringify({ url: this.page.url(), fields: [...this.fields.values()], files: uploaded }, null, 2))
  }

  /**
   * The submit gate. Dry run and assisted runs stop here with everything filled and recorded.
   * Returns true when the click happened.
   */
  async submit(button: Locator): Promise<boolean> {
    this.checkStopped()
    await this.screenshot('before-submit')
    this.writeEvidence()
    if (this.mode === 'dry_run') {
      this.step('info', 'Dry run: stopped before the final click.')
      return false
    }
    if (this.mode === 'assisted') {
      this.step('info', 'Filled. Review the form in the browser window and submit it yourself.')
      await this.page.bringToFront().catch(() => undefined)
      return false
    }
    this.step('click', 'Submitted the application.')
    await button.click()
    this.submitted = true
    return true
  }
}
