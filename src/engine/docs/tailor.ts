import { z } from 'zod'
import type { FactLockIssue, Judgment, Profile, ResumeContent, ResumeLine } from '../../shared/domain'
import { NO_INVENTION_RULE, block, definePrompt, untrusted } from '../ai/prompt'
import type { AiService, Meter } from '../ai/service'
import { canonicalTerm, findTerms } from '../jobs/terms'
import { countryName } from '../jobs/geo'
import { profileDigest } from '../profile/digest'
import { yearsOfExperience } from '../profile/store'
import { coverage, fold } from '../util/text'
import { factLock } from './factlock'
import { STYLE_RULES_FOR_PROMPTS, styleCheck } from './styleguard'

const Line = z.object({ sourceIds: z.array(z.string()).min(1), text: z.string().min(3) })
const PlanSchema = z.object({
  headline: z.string().describe('A title the candidate has actually held, or their current headline'),
  summary: z.object({ text: z.string(), factIds: z.array(z.string()) }),
  work: z.array(z.object({ workId: z.string(), bullets: z.array(Line) })),
  projects: z.array(z.object({ projectId: z.string(), bullets: z.array(Line) })),
  skills: z.array(z.string()),
})
export type TailorPlan = z.infer<typeof PlanSchema>

export type TailorInput = {
  profile: Profile
  job: { title: string; company: string; description: string }
  judgment: Judgment | null
  maxPages: 1 | 2
  feedback?: FactLockIssue[] | undefined
}

export const tailorPrompt = definePrompt<TailorInput, TailorPlan>({
  id: 'docs.tailor',
  version: 1,
  role: 'writer',
  system:
    "You tailor a candidate's resume to one job posting. The resume will be sent to a real employer under the candidate's name, " +
    'so every line must be true: you select, order and lightly rephrase facts from the profile; you never add facts. ' +
    'Code will check every number and named tool against the facts you cite and will reject anything that does not trace back.',
  describe: 'A resume plan built from cited profile facts.',
  maxOutputTokens: 5000,
  user: (i) => {
    const req = i.judgment?.requirements.map((r) => `- [${r.kind}] ${r.text} (${r.verdict}${r.evidence.length ? `; evidence ${r.evidence.join(', ')}` : ''})`).join('\n') ?? ''
    return [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 12_000)}`),
      block('candidate_profile', profileDigest(i.profile, { maxBullets: 20 })),
      req ? block('requirement_analysis', req) : '',
      i.feedback?.length ? block('rejected_last_time', i.feedback.map((f) => `- ${f.location}: ${f.message}`).join('\n')) : '',
      block(
        'instructions',
        [
          NO_INVENTION_RULE,
          `Build a ${i.maxPages === 1 ? 'one-page' : 'two-page'} resume plan for this posting.`,
          '- work: include every role from the profile, most recent first, using its workId. Give recent, relevant roles 3 to 6 bullets and older roles 1 to 3.',
          '- Each bullet cites the fact ids it restates in sourceIds, and only facts from that same role.',
          '- Rephrase only to put the posting\'s terms first where the fact supports them, to tighten wording, or to start with a strong past-tense verb (present tense for the current role).',
          '- Keep every number exactly as the fact states it. Do not round, combine or estimate numbers.',
          '- Name a tool or technology only if the cited fact or the skills list names it.',
          '- summary: 2 sentences, built from the profile. You may state total years of experience as given.',
          '- skills: reorder the profile\'s skills so the ones the posting asks for come first. Do not add skills.',
          '- headline: one of the titles the candidate has held, or their current headline.',
          STYLE_RULES_FOR_PROMPTS,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
  },
  schema: PlanSchema,
  mock: (i) => heuristicPlan(i),
})

/** Offline demo plan: picks and orders original bullets by relevance; never rewrites a number. */
export function heuristicPlan(i: TailorInput): TailorPlan {
  const kw = new Set((i.judgment?.keywords.length ? i.judgment.keywords : findTerms(i.job.description)).map((k) => fold(k)))
  const relevance = (text: string) => findTerms(text).filter((t) => kw.has(fold(t))).length + coverage(i.job.title, text)
  const years = yearsOfExperience(i.profile)
  const topSkills = i.profile.skills.map((s) => s.name).sort((a, b) => Number(kw.has(fold(b))) - Number(kw.has(fold(a))))
  const matched = topSkills.filter((s) => kw.has(fold(s))).slice(0, 3)
  return {
    headline: i.profile.work[0]?.title ?? i.profile.basics.headline,
    summary: {
      text: `${i.profile.work[0]?.title ?? 'Professional'} with ${Math.floor(years)} years of experience${matched.length ? ` in ${matched.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ''}. Recent work at ${i.profile.work[0]?.company ?? 'past employers'}.`,
      factIds: i.profile.work[0] ? [i.profile.work[0].id] : [],
    },
    work: i.profile.work.map((w, idx) => ({
      workId: w.id,
      bullets: [...w.bullets]
        .sort((a, b) => relevance(b.text) - relevance(a.text))
        .slice(0, idx === 0 ? 6 : idx === 1 ? 4 : 2)
        .map((b) => ({ sourceIds: [b.id], text: b.text })),
    })),
    projects: i.profile.projects.slice(0, 2).map((p) => ({ projectId: p.id, bullets: p.bullets.slice(0, 2).map((b) => ({ sourceIds: [b.id], text: b.text })) })),
    skills: topSkills,
  }
}

const monthsAgo = (end: string | null) => {
  if (!end) return 0
  const [y, m] = end.split('-').map(Number)
  const now = new Date()
  return (now.getFullYear() - (y ?? now.getFullYear())) * 12 + (now.getMonth() + 1 - (m ?? 12))
}

/** Assembles the resume from the plan. Structure (employers, titles, dates, education) is copied from the profile, never taken from the model. */
export function buildContent(profile: Profile, plan: TailorPlan): ResumeContent {
  const b = profile.basics
  const loc = [b.location.city, b.location.region || (b.location.country ? countryName(b.location.country) : '')].filter(Boolean).join(', ')
  const heldTitles = new Set([...profile.work.map((w) => fold(w.title)), fold(b.headline)])
  const headline = heldTitles.has(fold(plan.headline)) ? plan.headline : b.headline || profile.work[0]?.title || ''
  const planned = new Map(plan.work.map((w) => [w.workId, w.bullets]))
  return {
    name: b.name,
    headline,
    contact: { email: b.email, phone: b.phone, location: loc, links: b.links },
    summary: { text: plan.summary.text.trim(), factIds: plan.summary.factIds },
    work: profile.work
      // Roles from the last 15 years are always kept, so the resume has no unexplained gaps.
      .filter((w) => planned.has(w.id) || monthsAgo(w.end) < 180)
      .map((w) => ({
        workId: w.id,
        company: w.company,
        title: w.title,
        location: w.location,
        start: w.start,
        end: w.end,
        bullets: (planned.get(w.id) ?? w.bullets.slice(0, 2).map((x) => ({ sourceIds: [x.id], text: x.text }))).map((l) => ({ sourceIds: l.sourceIds, text: l.text.trim() })),
      })),
    education: profile.education.map((e) => ({ id: e.id, institution: e.institution, degree: e.degree, field: e.field, start: e.start, end: e.end, grade: e.grade })),
    projects: plan.projects
      .map((p) => {
        const src = profile.projects.find((x) => x.id === p.projectId)
        return src ? { id: src.id, name: src.name, url: src.url, bullets: p.bullets } : null
      })
      .filter((p): p is NonNullable<typeof p> => !!p),
    skills: [...new Set(plan.skills.map((s) => canonicalTerm(s) ?? s.trim()).filter(Boolean))],
    certifications: profile.certifications.map((c) => ({ name: c.name, issuer: c.issuer, date: c.date })),
    languages: profile.languages.map((l) => ({ name: l.name, fluency: l.fluency })),
  }
}

/** A plain base resume: every fact, chronological, no model involved. */
export function baseContent(profile: Profile): ResumeContent {
  return buildContent(profile, {
    headline: profile.basics.headline || profile.work[0]?.title || '',
    summary: { text: profile.basics.summary, factIds: [] },
    work: profile.work.map((w) => ({ workId: w.id, bullets: w.bullets.map((x) => ({ sourceIds: [x.id], text: x.text })) })),
    projects: profile.projects.map((p) => ({ projectId: p.id, bullets: p.bullets.map((x) => ({ sourceIds: [x.id], text: x.text })) })),
    skills: profile.skills.map((s) => s.name),
  })
}

/** Replaces lines that failed fact-lock with the original fact text, and marks them for review. */
export function revertFailing(content: ResumeContent, profile: Profile, issues: FactLockIssue[]): ResumeContent {
  const failing = new Set(issues.map((i) => i.location))
  const bulletText = new Map<string, string>()
  for (const w of profile.work) for (const x of w.bullets) bulletText.set(x.id, x.text)
  for (const p of profile.projects) for (const x of p.bullets) bulletText.set(x.id, x.text)
  const fix = (line: ResumeLine, loc: string): ResumeLine => {
    if (!failing.has(loc)) return line
    const original = line.sourceIds.map((id) => bulletText.get(id)).find(Boolean)
    return original ? { sourceIds: [line.sourceIds.find((id) => bulletText.has(id))!], text: original, flagged: 'Reverted to your original line: the rewrite did not match your profile.' } : { ...line, flagged: 'This line could not be verified.' }
  }
  const skillsFailing = new Set(issues.filter((i) => i.location.startsWith('skills.')).map((i) => i.token))
  const summaryFails = issues.some((i) => i.location === 'summary')
  return {
    ...content,
    summary: summaryFails ? { text: profile.basics.summary, factIds: [] } : content.summary,
    work: content.work.map((w, i) => ({ ...w, bullets: w.bullets.map((l, j) => fix(l, `work.${i}.bullets.${j}`)) })),
    projects: content.projects.map((p, i) => ({ ...p, bullets: p.bullets.map((l, j) => fix(l, `projects.${i}.bullets.${j}`)) })),
    skills: content.skills.filter((s) => !skillsFailing.has(s)),
  }
}

export type TailorResult = { content: ResumeContent; issues: FactLockIssue[]; retried: boolean; reverted: number }

/**
 * Generate, check with fact-lock, retry once with the violations, then revert whatever still fails.
 * The returned content always passes fact-lock except for lines explicitly flagged for the user.
 */
export async function tailorResume(ai: AiService, input: Omit<TailorInput, 'feedback'>, call: { signal?: AbortSignal | undefined; meter?: Meter | undefined } = {}): Promise<TailorResult> {
  let plan = await ai.structured(tailorPrompt, input, { task: 'Tailor resume', ...call })
  let content = buildContent(input.profile, plan)
  let issues = factLock(content, input.profile)
  let retried = false
  if (issues.length) {
    retried = true
    plan = await ai.structured(tailorPrompt, { ...input, feedback: issues }, { task: 'Tailor resume (retry)', ...call })
    content = buildContent(input.profile, plan)
    issues = factLock(content, input.profile)
  }
  // Style problems in individual lines: revert those lines too, rather than send filler.
  const styleFails = content.work.flatMap((w, i) =>
    w.bullets.flatMap((l, j) =>
      styleCheck(l.text, 'bullet', { currentRole: w.end === null }).some((s) => s.rule === 'banned_phrase' || s.rule === 'pronoun')
        ? [{ location: `work.${i}.bullets.${j}`, kind: 'structure' as const, token: '', message: 'Filler wording' }]
        : [],
    ),
  )
  const toRevert = [...issues, ...styleFails]
  const reverted = new Set(toRevert.map((x) => x.location)).size
  if (toRevert.length) content = revertFailing(content, input.profile, toRevert)
  return { content, issues: factLock(content, input.profile), retried, reverted }
}
