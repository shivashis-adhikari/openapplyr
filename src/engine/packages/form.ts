import { json } from '../core/db'
import type { Db } from '../core/db'
import type { Http } from '../core/http'
import { htmlToText } from '../util/html'
import type { FormQuestion } from '../answers/questions'
import { boardKey, detectAts } from '../sources/detect'

/**
 * The questions on a job's application form, known before the browser opens.
 * "api": read from the ATS. "cached": captured on an earlier application to the same board.
 * "standard": the fields every form on that ATS has; the run may meet more.
 */
export type FormSpec = { source: 'api' | 'cached' | 'standard'; questions: FormQuestion[] }

export type FormJob = { source_kind: string; external_id: string; url: string; apply_url: string | null; meta: string }

// ---------------------------------------------------------------------------
// Greenhouse: the public job endpoint returns the whole form with ?questions=true.

type GhField = { name: string; type: string; values?: { label: string; value?: unknown }[] }
type GhQuestion = { label: string; required: boolean; description?: string | null; fields: GhField[] }
type GhDemographic = { id: number; label: string; required: boolean; type: string; answer_options?: { id: number; label: string }[] }
type GhForm = {
  questions?: GhQuestion[]
  location_questions?: GhQuestion[]
  compliance?: { type: string; questions?: GhQuestion[] }[] | null
  demographic_questions?: { questions?: GhDemographic[] } | null
}

const GH_TYPES: Record<string, FormQuestion['type']> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multiselect',
}

function ghQuestion(q: GhQuestion): FormQuestion | null {
  // "Resume/CV" offers a file field and a paste field; the file comes first and is the one we use.
  const f = q.fields.find((x) => x.type !== 'input_hidden')
  if (!f) return null
  return {
    fieldName: f.name,
    label: q.label.trim(),
    type: GH_TYPES[f.type] ?? 'text',
    required: q.required,
    options: (f.values ?? []).map((v) => v.label),
    ...(q.description ? { description: htmlToText(q.description).slice(0, 500) } : {}),
  }
}

export function greenhouseForm(form: GhForm): FormQuestion[] {
  const out: FormQuestion[] = []
  for (const q of [...(form.questions ?? []), ...(form.location_questions ?? [])]) {
    const f = ghQuestion(q)
    if (f) out.push(f)
  }
  for (const c of form.compliance ?? []) for (const q of c.questions ?? []) {
    const f = ghQuestion(q)
    if (f) out.push(f)
  }
  for (const q of form.demographic_questions?.questions ?? []) {
    out.push({ fieldName: `demographic_${q.id}`, label: q.label.trim(), type: q.type === 'multi_value_multi_select' ? 'multiselect' : 'select', required: q.required, options: (q.answer_options ?? []).map((o) => o.label) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Recruitee: open questions come with the offer. The standard fields are the same on every form.

type RecruiteeQuestion = { id: number; body: string; kind: string; required: boolean; open_question_options?: { body: string }[] }

const RECRUITEE_TYPES: Record<string, FormQuestion['type']> = {
  string: 'text',
  text: 'textarea',
  boolean: 'radio',
  single_choice: 'select',
  multi_choice: 'multiselect',
  date: 'date',
  file: 'file',
  number: 'number',
}

export function recruiteeForm(open: unknown): FormQuestion[] {
  const standard: FormQuestion[] = [
    { fieldName: 'candidate[name]', label: 'Full name', type: 'text', required: true, options: [] },
    { fieldName: 'candidate[email]', label: 'Email', type: 'email', required: true, options: [] },
    { fieldName: 'candidate[phone]', label: 'Phone', type: 'tel', required: false, options: [] },
    { fieldName: 'candidate[cv]', label: 'CV', type: 'file', required: false, options: [] },
    { fieldName: 'candidate[cover_letter]', label: 'Cover letter', type: 'textarea', required: false, options: [] },
  ]
  const questions = (Array.isArray(open) ? (open as RecruiteeQuestion[]) : [])
    .filter((q) => q.kind !== 'infobox' && RECRUITEE_TYPES[q.kind])
    .map(
      (q): FormQuestion => ({
        fieldName: `open_question_${q.id}`,
        label: htmlToText(q.body).trim(),
        type: RECRUITEE_TYPES[q.kind]!,
        required: q.required,
        options: q.kind === 'boolean' ? ['Yes', 'No'] : (q.open_question_options ?? []).map((o) => o.body),
      }),
    )
  return [...standard, ...questions]
}

// ---------------------------------------------------------------------------
// Lever: custom questions are not in the public API; these fields are on every Lever form.

export const LEVER_STANDARD: FormQuestion[] = [
  { fieldName: 'resume', label: 'Resume/CV', type: 'file', required: true, options: [] },
  { fieldName: 'name', label: 'Full name', type: 'text', required: true, options: [] },
  { fieldName: 'email', label: 'Email', type: 'email', required: true, options: [] },
  { fieldName: 'phone', label: 'Phone', type: 'tel', required: false, options: [] },
  { fieldName: 'org', label: 'Current company', type: 'text', required: false, options: [] },
  { fieldName: 'urls[LinkedIn]', label: 'LinkedIn URL', type: 'url', required: false, options: [] },
  { fieldName: 'urls[GitHub]', label: 'GitHub URL', type: 'url', required: false, options: [] },
  { fieldName: 'urls[Portfolio]', label: 'Portfolio URL', type: 'url', required: false, options: [] },
  { fieldName: 'comments', label: 'Additional information', type: 'textarea', required: false, options: [] },
]

// ---------------------------------------------------------------------------

/** "greenhouse:stripe", used to reuse a form captured on an earlier application. */
export function formBoardKey(job: Pick<FormJob, 'url' | 'apply_url'>): string | null {
  const d = detectAts(job.apply_url ?? job.url) ?? detectAts(job.url)
  return d?.board ? `${d.ats}:${boardKey(d.ats, d.board)}` : null
}

export function cachedForm(db: Db, key: string): FormQuestion[] | null {
  const row = db.get<{ spec: string }>('SELECT spec FROM form_specs WHERE board_key = ?', [key])
  return row ? json.parse<FormQuestion[]>(row.spec, []) : null
}

export function saveFormSpec(db: Db, key: string, questions: FormQuestion[], now: number): void {
  db.run('INSERT INTO form_specs (board_key, spec, captured_at) VALUES (?, ?, ?) ON CONFLICT(board_key) DO UPDATE SET spec = excluded.spec, captured_at = excluded.captured_at', [key, JSON.stringify(questions), now])
}

/** Best available form for a job. Network errors fall back to the cache; the run discovers the rest. */
export async function formSpecFor(db: Db, http: Http, job: FormJob, signal?: AbortSignal): Promise<FormSpec | null> {
  const meta = json.parse<Record<string, unknown>>(job.meta, {})
  const d = detectAts(job.apply_url ?? job.url) ?? detectAts(job.url)
  const key = formBoardKey(job)
  if (job.source_kind === 'greenhouse' || d?.ats === 'greenhouse') {
    const token = typeof meta['token'] === 'string' ? meta['token'] : d?.board?.['token']
    const id = job.source_kind === 'greenhouse' ? job.external_id : d?.jobId
    if (token && id) {
      try {
        const form = await http.getJson<GhForm>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}?questions=true`, {
          timeoutMs: 30_000,
          ...(signal ? { signal } : {}),
        })
        const questions = greenhouseForm(form)
        if (questions.length) return { source: 'api', questions }
      } catch {
        /* fall through to the cache */
      }
    }
  }
  if (job.source_kind === 'recruitee' && meta['questions'] !== undefined) return { source: 'api', questions: recruiteeForm(meta['questions']) }
  const cached = key ? cachedForm(db, key) : null
  if (cached?.length) return { source: 'cached', questions: cached }
  if (d?.ats === 'lever') return { source: 'standard', questions: LEVER_STANDARD }
  return null
}
