import type { Frame } from 'playwright-core'
import type { FormQuestion } from '../answers/questions'
import { pickOption } from '../answers/questions'
import { countryCode } from '../jobs/geo'
import readerSource from './page/reader.js?raw'

export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'combobox' | 'buttons' | 'file' | 'date' | 'number'

/** One question on the page, as read by page/reader.js. */
export type PageField = {
  id: string
  kind: FieldKind
  inputType: string
  name: string
  label: string
  required: boolean
  options: string[]
  value: string
  maxLength: number | null
}

export type PageButton = { id: string; text: string; type: string }

export type PageState = {
  url: string
  title: string
  fields: PageField[]
  buttons: PageButton[]
  errors: string[]
  challenge: boolean
  /** A visible password box: the site wants the person to sign in or create an account. */
  login: boolean
  text: string
}

export const readPage = async (frame: Frame): Promise<PageState> => (await frame.evaluate(readerSource)) as PageState

const QUESTION_TYPE: Record<FieldKind, FormQuestion['type']> = {
  text: 'text',
  textarea: 'textarea',
  select: 'select',
  radio: 'radio',
  checkbox: 'checkbox',
  checkboxes: 'multiselect',
  combobox: 'select',
  buttons: 'radio',
  file: 'file',
  date: 'date',
  number: 'number',
}

export function toQuestion(f: PageField): FormQuestion {
  const t = QUESTION_TYPE[f.kind]
  const type = f.kind === 'text' && ['email', 'tel', 'url'].includes(f.inputType) ? (f.inputType as FormQuestion['type']) : t
  return { fieldName: f.name || f.label, label: f.label, type, required: f.required, options: f.options, maxLength: f.maxLength ?? undefined }
}

export type FillResult = { ok: boolean; value: string; note?: string }

const sel = (f: PageField, opt?: number) => `[data-oa-field="${f.id}"]${opt === undefined ? '' : `[data-oa-opt="${opt}"]`}`
const YES = /^(yes|y|true|checked|agree|i agree|accept|i accept|i acknowledge|i confirm|i consent|confirmed?)\b/i

/** Picks the option for an answer, matching countries across spellings ("UK" for "United Kingdom"). */
export function chooseOption(options: string[], answer: string): string | null {
  const code = countryCode(answer)
  if (code) {
    const byCountry = options.find((o) => countryCode(o.replace(/\s*\+\d+$/, '')) === code)
    if (byCountry) return byCountry
  }
  return pickOption(options, answer)
}

/** Trims to a length limit at a sentence end where possible, never mid-word. */
export function fitLength(text: string, max: number | null): string {
  if (!max || text.length <= max) return text
  const cut = text.slice(0, max)
  const sentence = cut.lastIndexOf('. ')
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? cut.slice(0, space) : cut
}

/**
 * Location fields often need a suggestion picked from a list before the form accepts them
 * (Lever keeps the typed text but also wants a selected place). Picks the best match when one appears.
 */
async function pickSuggestion(frame: Frame, input: ReturnType<Frame['locator']>, value: string): Promise<FillResult> {
  const list = frame.locator('[role=option]:visible, .dropdown-location:visible, .pac-item:visible')
  await input.pressSequentially(' ', { delay: 10 }).catch(() => undefined)
  await input.press('Backspace').catch(() => undefined)
  await list.first().waitFor({ timeout: 2500 }).catch(() => undefined)
  const texts = (await list.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim())
  const pick = texts.length ? chooseOption(texts, value) : null
  if (pick) {
    await list.nth(texts.indexOf(pick)).click()
    return { ok: true, value: pick }
  }
  return { ok: true, value }
}

async function fillCombobox(frame: Frame, f: PageField, answer: string): Promise<FillResult> {
  const input = frame.locator(sel(f)).first()
  const options = frame.locator('[role=option]:visible')
  const pickVisible = async (): Promise<boolean> => {
    await options.first().waitFor({ timeout: 2500 }).catch(() => undefined)
    const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
    const pick = chooseOption(texts, answer)
    if (!pick) return false
    await options.nth(texts.indexOf(pick)).click()
    return true
  }
  await input.click()
  // Short lists show everything on open; long ones (countries, cities) need typing to filter.
  if (await pickVisible()) return { ok: true, value: answer }
  for (const query of [answer.slice(0, 40), answer.split(/[\s,(]/)[0] ?? '']) {
    if (!query) continue
    await input.fill('')
    await input.pressSequentially(query, { delay: 25 })
    if (await pickVisible()) return { ok: true, value: answer }
  }
  await input.press('Escape').catch(() => undefined)
  return { ok: false, value: '', note: `None of the choices matched "${answer}".` }
}

/**
 * Fills one field with an answer. Choice fields only ever get one of their own options; when no option
 * fits, the field is left alone and the caller asks the user.
 */
export async function fillField(frame: Frame, f: PageField, answer: string, files: { resume: string; coverLetter: string | null }): Promise<FillResult> {
  const loc = frame.locator(sel(f))
  switch (f.kind) {
    case 'file': {
      const path = answer === 'cover_letter' ? files.coverLetter : files.resume
      if (!path) return { ok: false, value: '', note: 'No file for this field.' }
      await loc.first().setInputFiles(path)
      return { ok: true, value: path.split(/[\\/]/).pop() ?? path }
    }
    case 'select': {
      const pick = chooseOption(f.options, answer)
      if (!pick) return { ok: false, value: '', note: `None of the choices matched "${answer}".` }
      await loc.first().selectOption({ label: pick })
      return { ok: true, value: pick }
    }
    case 'radio':
    case 'buttons': {
      const pick = chooseOption(f.options, answer)
      if (!pick) return { ok: false, value: '', note: `None of the choices matched "${answer}".` }
      const opt = frame.locator(sel(f, f.options.indexOf(pick))).first()
      if (f.kind === 'buttons') await opt.click()
      // Styled radios hide the input; clicking its label is what a person does.
      else await opt.check({ force: true }).catch(() => opt.evaluate('(el) => ((el.labels && el.labels[0]) || el).click()'))
      return { ok: true, value: pick }
    }
    case 'checkboxes': {
      const wanted = answer.split(/\n|;\s*/).map((x) => x.trim()).filter(Boolean)
      const picks = [...new Set(wanted.map((w) => chooseOption(f.options, w)).filter((x): x is string => !!x))]
      if (!picks.length) return { ok: false, value: '', note: `None of the choices matched "${answer}".` }
      for (const p of picks) await frame.locator(sel(f, f.options.indexOf(p))).first().check({ force: true })
      return { ok: true, value: picks.join('; ') }
    }
    case 'checkbox': {
      const on = YES.test(answer.trim())
      const box = loc.first()
      if (on) await box.check({ force: true })
      else if (await box.isChecked()) await box.uncheck({ force: true })
      return { ok: true, value: on ? 'Checked' : 'Not checked' }
    }
    case 'combobox':
      return fillCombobox(frame, f, answer)
    case 'date': {
      if (f.inputType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) return { ok: false, value: '', note: 'Needs a date.' }
      await loc.first().fill(answer)
      return { ok: true, value: answer }
    }
    default: {
      const value = f.kind === 'number' ? (/-?\d+(\.\d+)?/.exec(answer)?.[0] ?? '') : fitLength(answer, f.maxLength)
      if (!value) return { ok: false, value: '', note: 'Needs a number.' }
      await loc.first().fill(value)
      if (/\b(location|city)\b/i.test(f.label)) return pickSuggestion(frame, loc.first(), value)
      return { ok: true, value }
    }
  }
}
