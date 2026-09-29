import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AnswerKind, AnswerSource, PreparedAnswer, Profile } from '../../shared/domain'
import { NO_INVENTION_RULE, block, definePrompt, untrusted } from '../ai/prompt'
import type { AiService, Meter } from '../ai/service'
import type { Db } from '../core/db'
import { STYLE_RULES_FOR_PROMPTS, styleCheck } from '../docs/styleguard'
import { countryCode, countryName } from '../jobs/geo'
import { canonicalTerm } from '../jobs/terms'
import { profileDigest } from '../profile/digest'
import { skillMonths, yearsOfExperience } from '../profile/store'
import { companyKey } from '../jobs/classify'
import { type Classified, type FormQuestion, classifyQuestion, pickOption } from './questions'

export type BankRow = { id: number; key: string; question: string; answer: string; kind: AnswerKind; scope_company_id: number | null; source: string }

export const questionKey = (label: string) => `q:${createHash('sha1').update(label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 16)}`

export function bankLookup(db: Db, keys: string[], companyId: number | null): BankRow | null {
  for (const key of keys) {
    const scoped = companyId ? db.get<BankRow>('SELECT * FROM answers WHERE key = ? AND scope_company_id = ?', [key, companyId]) : undefined
    if (scoped) return scoped
    const global = db.get<BankRow>('SELECT * FROM answers WHERE key = ? AND scope_company_id IS NULL', [key])
    if (global) return global
  }
  return null
}

export function bankSave(db: Db, a: { key: string; question: string; answer: string; kind: AnswerKind; companyId: number | null; source: 'user' | 'approved_generated' }, now: number): void {
  db.run(
    `INSERT INTO answers (key, question, answer, kind, scope_company_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, IFNULL(scope_company_id, 0)) DO UPDATE SET answer = excluded.answer, question = excluded.question, source = excluded.source, updated_at = excluded.updated_at`,
    [a.key, a.question, a.answer, a.kind, a.companyId, a.source, now, now],
  )
}

export type ResolveContext = {
  profile: Profile
  job: { title: string; company: string; companyId: number | null; country: string | null; description: string }
  db: Db
  letterText: string | null
  allowGenerated: boolean
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No')

const COUNTRY_KEYS = new Set(['location_country', 'work_country'])
/** "United Kingdom" is "UK" on one form and "Great Britain" on the next. */
const pickCountry = (options: string[], answer: string) => {
  const code = countryCode(answer)
  return code ? (options.find((o) => countryCode(o) === code) ?? null) : null
}

/** What the profile says for a canonical key, or null when the profile has no answer. */
function fromProfile(key: string, c: ResolveContext): { answer: string; source: AnswerSource } | null {
  const p = c.profile
  const b = p.basics
  const [first = '', ...rest] = b.name.trim().split(/\s+/)
  const link = (re: RegExp) => b.links.find((l) => re.test(l.url) || re.test(l.label))?.url ?? null
  const work0 = p.work[0]
  switch (key) {
    case 'first_name':
      return first ? { answer: first, source: 'profile' } : null
    case 'last_name':
      return rest.length ? { answer: rest.join(' '), source: 'profile' } : null
    case 'full_name':
    case 'preferred_name':
      return b.name ? { answer: key === 'preferred_name' ? first : b.name, source: 'profile' } : null
    case 'email':
      return b.email ? { answer: b.email, source: 'profile' } : null
    case 'phone':
      return b.phone ? { answer: b.phone, source: 'profile' } : null
    case 'linkedin': {
      const u = link(/linkedin/i)
      return u ? { answer: u, source: 'profile' } : null
    }
    case 'github': {
      const u = link(/github/i)
      return u ? { answer: u, source: 'profile' } : null
    }
    case 'portfolio': {
      const u = b.links.find((l) => !/linkedin|github/i.test(l.url))?.url
      return u ? { answer: u, source: 'profile' } : null
    }
    case 'location_city':
      return b.location.city ? { answer: [b.location.city, b.location.region, b.location.country ? countryName(b.location.country) : ''].filter(Boolean).join(', '), source: 'profile' } : null
    case 'location_country':
      return b.location.country ? { answer: countryName(b.location.country), source: 'profile' } : null
    case 'over_18':
      return p.jobSearch.over18 === null ? null : { answer: yesNo(p.jobSearch.over18), source: 'profile' }
    case 'drivers_license':
      return p.jobSearch.driversLicense === null ? null : { answer: yesNo(p.jobSearch.driversLicense), source: 'profile' }
    case 'clearance':
      return p.jobSearch.clearance ? { answer: p.jobSearch.clearance, source: 'profile' } : null
    case 'work_country': {
      const country = c.job.country ?? p.basics.location.country
      return country ? { answer: countryName(country), source: 'computed' } : null
    }
    case 'sponsorship': {
      const country = c.job.country ?? p.basics.location.country
      const auth = p.jobSearch.workAuthorization.find((a) => a.country === country)
      return auth ? { answer: yesNo(auth.needsSponsorship), source: 'profile' } : null
    }
    case 'notice_period':
      return p.jobSearch.noticePeriod ? { answer: p.jobSearch.noticePeriod, source: 'profile' } : null
    case 'start_date':
      return p.jobSearch.earliestStart || p.jobSearch.noticePeriod ? { answer: p.jobSearch.earliestStart || `After a notice period of ${p.jobSearch.noticePeriod}`, source: 'profile' } : null
    case 'relocation':
      return p.jobSearch.relocation === 'maybe' ? null : { answer: yesNo(p.jobSearch.relocation === 'yes'), source: 'profile' }
    case 'travel':
      return p.jobSearch.willingToTravel ? { answer: p.jobSearch.willingToTravel, source: 'profile' } : null
    case 'salary_expected': {
      const m = p.jobSearch.expectedCompensation
      return m ? { answer: `${m.amount}`, source: 'profile' } : null
    }
    case 'salary_current': {
      const m = p.jobSearch.currentCompensation
      return m ? { answer: `${m.amount}`, source: 'profile' } : null
    }
    case 'years_experience':
      return { answer: String(Math.floor(yearsOfExperience(p))), source: 'computed' }
    case 'current_employer':
      return work0 ? { answer: work0.company, source: 'profile' } : null
    case 'current_title':
      return work0 ? { answer: work0.title, source: 'profile' } : null
    case 'degree':
      return p.education[0]?.degree ? { answer: p.education[0].degree, source: 'profile' } : null
    case 'school':
      return p.education[0] ? { answer: p.education[0].institution, source: 'profile' } : null
    case 'graduation':
      return p.education[0]?.end ? { answer: p.education[0].end.slice(0, 4), source: 'profile' } : null
    case 'languages':
      return p.languages.length ? { answer: p.languages.map((l) => (l.fluency ? `${l.name} (${l.fluency})` : l.name)).join(', '), source: 'profile' } : null
    case 'previously_employed':
      return { answer: yesNo(p.work.some((w) => companyKey(w.company) === companyKey(c.job.company))), source: 'computed' }
    case 'gender':
    case 'race':
    case 'hispanic':
    case 'veteran':
    case 'disability':
    case 'pronouns': {
      const v = (p.jobSearch.eeo as Record<string, string>)[key]
      return { answer: v || 'Decline to self-identify', source: v ? 'profile' : 'default' }
    }
    case 'sexual_orientation':
      return { answer: 'Decline to self-identify', source: 'default' }
    case 'cover_letter':
      return c.letterText ? { answer: c.letterText, source: 'generated' } : null
  }
  if (key.startsWith('authorized:')) {
    const code = key.slice('authorized:'.length)
    const country = code === 'job' ? (c.job.country ?? p.basics.location.country) : code
    if (country === 'EU') {
      const eu = p.jobSearch.workAuthorization.find((a) => ['DE', 'FR', 'NL', 'IE', 'ES', 'PT', 'IT', 'BE', 'AT', 'SE', 'FI', 'DK', 'PL'].includes(a.country))
      return eu ? { answer: yesNo(eu.authorized), source: 'profile' } : null
    }
    const auth = p.jobSearch.workAuthorization.find((a) => a.country === country)
    return auth ? { answer: yesNo(auth.authorized), source: 'profile' } : null
  }
  if (key.startsWith('skill_years:')) {
    const skill = key.slice('skill_years:'.length)
    // "kafka" and its canonical "Apache Kafka" both count.
    const months = Math.max(skillMonths(p, skill), skillMonths(p, canonicalTerm(skill) ?? skill))
    // No evidence is not the same as zero years: the user answers.
    return months >= 12 ? { answer: String(Math.floor(months / 12)), source: 'computed' } : null
  }
  return null
}

const ClassifySchema = z.object({ items: z.array(z.object({ index: z.number().int(), key: z.string(), kind: z.enum(['fact', 'computed', 'open', 'legal', 'eeo', 'salary', 'choice', 'contact', 'consent']), confidence: z.number().min(0).max(1) })) })

export const classifyPrompt = definePrompt<{ questions: { index: number; label: string; type: string; options: string[] }[]; keys: string[] }, z.infer<typeof ClassifySchema>>({
  id: 'answers.classify',
  version: 1,
  role: 'fast',
  system: 'You map job application questions to a fixed list of known question types, so saved answers can be reused. When unsure, say so with a low confidence.',
  describe: 'Question classifications.',
  maxOutputTokens: 1200,
  cache: true,
  user: ({ questions, keys }) =>
    [
      untrusted('application form', questions.map((q) => `${q.index}. [${q.type}] ${q.label}${q.options.length ? ` (options: ${q.options.slice(0, 12).join(' | ')})` : ''}`).join('\n')),
      block('known_keys', keys.join('\n')),
      block(
        'instructions',
        'For each question, give the matching key from the list, or "open" for a free-text question about the candidate\'s motivation or experience, or "unknown". ' +
          'kind: legal for eligibility, law and background questions; eeo for demographic questions; consent for agreements. Confidence 0 to 1.',
      ),
    ].join('\n\n'),
  schema: ClassifySchema,
  mock: ({ questions }) => ({ items: questions.map((q) => ({ index: q.index, key: 'unknown', kind: 'fact' as const, confidence: 0 })) }),
})

export const KNOWN_KEYS = [
  'first_name', 'last_name', 'full_name', 'email', 'phone', 'linkedin', 'github', 'portfolio', 'location_city', 'location_country', 'postal_code', 'address',
  'authorized:job', 'sponsorship', 'over_18', 'clearance', 'drivers_license', 'criminal', 'non_compete', 'background_check', 'citizenship', 'previously_employed',
  'salary_expected', 'salary_current', 'notice_period', 'start_date', 'relocation', 'travel', 'onsite_ok', 'years_experience', 'current_employer', 'current_title',
  'degree', 'school', 'graduation', 'languages', 'referral', 'how_heard', 'gender', 'race', 'hispanic', 'veteran', 'disability', 'pronouns', 'consent_privacy',
  'why_company', 'additional_info', 'cover_letter', 'visa_status', 'work_country',
]

const AnswerSchema = z.object({ answer: z.string().min(1), factIds: z.array(z.string()) })

export const writeAnswerPrompt = definePrompt<{ profile: Profile; question: string; maxLength: number | null; job: ResolveContext['job'] }, z.infer<typeof AnswerSchema>>({
  id: 'answers.write',
  version: 1,
  role: 'writer',
  system:
    "You answer an open question on a job application in the candidate's voice. The answer is submitted under their name, so it must use only facts from their profile and the posting.",
  describe: 'An application answer.',
  maxOutputTokens: 800,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 8000)}`),
      block('candidate_profile', profileDigest(i.profile)),
      untrusted('application question', i.question),
      block(
        'instructions',
        [
          NO_INVENTION_RULE,
          `Answer the question in first person, ${i.maxLength ? `under ${Math.floor(i.maxLength * 0.9)} characters` : '60 to 140 words'}.`,
          'Be specific: connect one or two facts from the profile to something the posting says. List the fact ids you used.',
          STYLE_RULES_FOR_PROMPTS,
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: AnswerSchema,
  mock: (i) => {
    const w = i.profile.work[0]
    const b = w?.bullets[0]
    const text = w && b ? `In my current role as ${w.title} at ${w.company}, I ${b.text.charAt(0).toLowerCase()}${b.text.slice(1).replace(/\.$/, '')}. The ${i.job.title} role at ${i.job.company} builds on that work.` : `The ${i.job.title} role at ${i.job.company} matches the work I have done so far.`
    return { answer: i.maxLength ? text.slice(0, i.maxLength) : text, factIds: b ? [b.id] : [] }
  },
})

/**
 * Resolves every question on a form. Order: saved answer for this company, saved answer, profile fact,
 * computed value, then policy: legal and salary questions are never generated; EEO defaults to declining;
 * open questions are written only when the hunt allows it.
 */
export async function resolveForm(questions: FormQuestion[], c: ResolveContext, ai: AiService | null, call: { signal?: AbortSignal | undefined; meter?: Meter | undefined } = {}): Promise<PreparedAnswer[]> {
  const classes: (Classified | null)[] = questions.map((q) => (q.type === 'file' && /resume|cv/i.test(q.label) ? { key: 'resume', kind: 'file', confidence: 1 } : classifyQuestion(q)))
  const unknown = questions.map((q, index) => ({ index, label: q.label, type: q.type, options: q.options })).filter((q) => !classes[q.index] && !bankLookup(c.db, [questionKey(q.label)], c.job.companyId))
  if (ai && unknown.length && !ai.isMock()) {
    try {
      const r = await ai.structured(classifyPrompt, { questions: unknown, keys: KNOWN_KEYS }, { task: 'Classify questions', ...call })
      for (const it of r.items) {
        if (it.key !== 'unknown' && it.confidence >= 0.75 && classes[it.index] === null) classes[it.index] = { key: it.key === 'open' ? `open:${questions[it.index]!.label.slice(0, 80)}` : it.key, kind: it.key === 'open' ? 'open' : it.kind, confidence: it.confidence }
      }
    } catch {
      /* unclassified questions fall through to "ask the user" */
    }
  }
  const out: PreparedAnswer[] = []
  for (const [i, q] of questions.entries()) {
    const cls = classes[i]
    const keys = [...(cls ? [cls.key] : []), questionKey(q.label)]
    const base = { fieldName: q.fieldName, question: q.label, key: cls?.key ?? questionKey(q.label), kind: cls?.kind ?? ('fact' as AnswerKind), required: q.required, options: q.options }
    const done = (answer: string, source: AnswerSource, confidence: number) => {
      let a = answer
      if (q.options.length && q.type === 'multiselect') {
        // "English (Fluent), Portuguese (Native)" -> the matching options, one per line.
        const parts = answer.split(/\n|;|,/).map((x) => x.replace(/\(.*?\)/g, '').trim()).filter(Boolean)
        const picks = [...new Set(parts.map((x) => pickOption(q.options, x)).filter((x): x is string => !!x))]
        if (!picks.length) return out.push({ ...base, answer, source, confidence: 0.3, needsUser: q.required })
        return out.push({ ...base, answer: picks.join('\n'), source, confidence, needsUser: false })
      }
      if (q.options.length && q.type !== 'text' && q.type !== 'textarea') {
        const picked = (COUNTRY_KEYS.has(base.key) && pickCountry(q.options, answer)) || pickOption(q.options, answer)
        if (!picked) return out.push({ ...base, answer, source, confidence: 0.3, needsUser: q.required })
        a = picked
      }
      out.push({ ...base, answer: a, source, confidence, needsUser: false })
    }
    if (q.type === 'file') {
      out.push({ ...base, kind: 'file', answer: /cover/i.test(q.label) ? 'cover_letter' : 'resume', source: 'default', confidence: 1, needsUser: false })
      continue
    }
    const saved = bankLookup(c.db, keys, c.job.companyId)
    if (saved) {
      done(saved.answer, 'bank', 0.95)
      continue
    }
    const prof = cls ? fromProfile(cls.key, c) : null
    if (prof) {
      done(prof.answer, prof.source, cls!.confidence)
      continue
    }
    // A required acknowledgement is part of applying. A consent that offers "No" is a real choice, so the user makes it.
    if (cls?.kind === 'consent' && q.required && !q.options.some((o) => /^(no|i do not|i don'?t|decline|disagree)\b/i.test(o.trim()))) {
      done(q.options.find((o) => /^(yes|i agree|i acknowledge|i consent|i confirm|agree|accept)/i.test(o)) ?? 'Yes', 'default', 0.9)
      continue
    }
    if (cls?.key === 'how_heard') {
      done(q.options.find((o) => /(career|company|website|job board|online)/i.test(o)) ?? 'Company website', 'default', 0.8)
      continue
    }
    // Optional open questions stay blank: a written answer nobody asked for is more risk than help.
    const openish = cls?.kind === 'open' || (!cls && q.type === 'textarea')
    if (openish && q.required && c.allowGenerated && ai) {
      try {
        const r = await ai.structured(writeAnswerPrompt, { profile: c.profile, question: q.label, maxLength: q.maxLength ?? null, job: c.job }, { task: 'Write answer', ...call })
        const issues = styleCheck(r.answer, 'answer')
        out.push({ ...base, kind: 'open', answer: r.answer, source: 'generated', confidence: issues.length ? 0.5 : 0.8, needsUser: issues.length > 0 && q.required })
        continue
      } catch {
        /* fall through: the user answers */
      }
    }
    // Legal, salary and anything unknown: the user decides. Optional questions stay blank.
    out.push({ ...base, answer: '', source: 'user', confidence: 0, needsUser: q.required })
  }
  return out
}

