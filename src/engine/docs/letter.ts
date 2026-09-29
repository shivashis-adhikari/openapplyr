import { z } from 'zod'
import type { Judgment, Profile, ResumeContent, ReviewIssue, StyleIssue } from '../../shared/domain'
import { NO_INVENTION_RULE, block, definePrompt, untrusted } from '../ai/prompt'
import type { AiService, Meter } from '../ai/service'
import { canonicalTerm, findTerms } from '../jobs/terms'
import { profileDigest } from '../profile/digest'
import { coverage, fold } from '../util/text'
import { STYLE_RULES_FOR_PROMPTS, styleCheck } from './styleguard'

// ---------------------------------------------------------------------------
// Reviewer: a second model reads the draft as a hiring manager would.

const ReviewSchema = z.object({
  issues: z
    .array(
      z.object({
        kind: z.enum(['unsupported', 'missed_match', 'weak', 'generic']),
        location: z.string().describe('Which line, for example "work 1, bullet 2" or "summary"'),
        message: z.string(),
        suggestion: z.string(),
      }),
    )
    .max(10),
})

export type ReviewInput = { profile: Profile; resumeText: string; job: { title: string; company: string; description: string } }

export const reviewPrompt = definePrompt<ReviewInput, { issues: ReviewIssue[] }>({
  id: 'docs.review',
  version: 1,
  role: 'review',
  system:
    'You review a tailored resume the way a hiring manager for this role would, looking for reasons to say no, and you check it against the ' +
    "candidate's own profile. You report problems; you do not rewrite the resume.",
  describe: 'Review findings.',
  maxOutputTokens: 1500,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 10_000)}`),
      block('candidate_profile', profileDigest(i.profile)),
      block('tailored_resume', i.resumeText),
      block(
        'instructions',
        [
          'Report up to 10 problems, most important first:',
          '- unsupported: a claim in the resume that the profile does not support.',
          '- missed_match: something the posting asks for that the profile shows but the resume leaves out.',
          '- weak: a line that states a duty instead of a result, when the profile has the result.',
          '- generic: wording that could be on anyone\'s resume.',
          'Only report problems that matter for this posting. If the resume is sound, return an empty list.',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: ReviewSchema,
  mock: (i) => {
    const issues: ReviewIssue[] = []
    const resumeTerms = new Set(findTerms(i.resumeText).map(fold))
    const profileTerms = new Set(findTerms(profileDigest(i.profile)).map(fold))
    for (const t of findTerms(i.job.description)) {
      if (profileTerms.has(fold(t)) && !resumeTerms.has(fold(t))) {
        issues.push({ kind: 'missed_match', location: 'skills', message: `The posting asks for ${t}, which your profile shows but this resume does not mention.`, suggestion: `Include a line that shows ${t}.` })
      }
    }
    const lines = i.resumeText.split('\n').filter((l) => l.startsWith('- '))
    for (const [n, l] of lines.entries()) {
      if (!/\d/.test(l) && /^- (responsible|worked|helped|assisted|participated)/i.test(l)) {
        issues.push({ kind: 'weak', location: `bullet ${n + 1}`, message: 'This line describes a duty, not a result.', suggestion: 'Lead with what changed because of the work.' })
      }
    }
    return { issues: issues.slice(0, 10) }
  },
})

export function resumeAsText(c: ResumeContent): string {
  const lines = [c.name, c.headline, '', c.summary.text, '']
  for (const w of c.work) {
    lines.push(`${w.title}, ${w.company} (${w.start} to ${w.end ?? 'present'})`)
    for (const b of w.bullets) lines.push(`- ${b.text}`)
  }
  for (const p of c.projects) {
    lines.push(`Project: ${p.name}`)
    for (const b of p.bullets) lines.push(`- ${b.text}`)
  }
  lines.push('', `Skills: ${c.skills.join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Cover letter

const LetterSchema = z.object({
  greeting: z.string(),
  paragraphs: z.array(z.object({ text: z.string(), factIds: z.array(z.string()) })).min(2).max(4),
  closing: z.string(),
})
export type LetterPlan = z.infer<typeof LetterSchema>

export type LetterInput = {
  profile: Profile
  job: { title: string; company: string; description: string }
  judgment: Judgment | null
  voice: string
  region: string
  feedback?: StyleIssue[] | undefined
}

export const letterPrompt = definePrompt<LetterInput, LetterPlan>({
  id: 'docs.letter',
  version: 1,
  role: 'writer',
  system:
    'You write a short cover letter that a busy hiring manager will actually read. It is sent under the candidate\'s name, so every claim about the ' +
    'candidate must come from their profile, and every claim about the company must come from the posting. Specific beats enthusiastic.',
  describe: 'A cover letter.',
  maxOutputTokens: 1500,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 10_000)}`),
      block('candidate_profile', profileDigest(i.profile, { contact: true })),
      i.judgment ? block('strongest_matches', i.judgment.requirements.filter((r) => r.verdict !== 'missing').slice(0, 6).map((r) => `- ${r.text} (facts ${r.evidence.join(', ') || 'none'})`).join('\n')) : '',
      i.voice ? block('candidate_voice', i.voice) : '',
      i.feedback?.length ? block('fix_these', i.feedback.map((f) => `- ${f.message} (${f.excerpt})`).join('\n')) : '',
      block(
        'instructions',
        [
          NO_INVENTION_RULE,
          `Write a cover letter for the ${i.job.title} role at ${i.job.company}, 180 to 260 words, ${i.region === 'US' || i.region === 'CA' ? 'US' : 'UK'} English.`,
          '- First paragraph: the role, and one specific reason drawn from the posting (what the team does or a problem the posting names).',
          '- Two body paragraphs: each connects one or two requirements from the posting to specific facts from the profile, with their numbers. List the fact ids in factIds.',
          '- Closing paragraph: one or two sentences, a plain request to talk.',
          '- greeting: "Dear Hiring Manager," unless the posting names a person. closing: "Best regards," or "Kind regards,".',
          '- Do not claim knowledge of the company beyond the posting.',
          STYLE_RULES_FOR_PROMPTS,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n'),
  schema: LetterSchema,
  mock: (i) => heuristicLetter(i),
})

function heuristicLetter(i: LetterInput): LetterPlan {
  const p = i.profile
  const met = (i.judgment?.requirements ?? []).filter((r) => r.verdict !== 'missing')
  const bullets = p.work.flatMap((w) => w.bullets.map((b) => ({ ...b, work: w })))
  const used = new Set<string>()
  const best = (req: string) =>
    bullets
      .filter((b) => !used.has(b.id))
      .map((b) => ({ b, s: coverage(req, b.text) + findTerms(req).filter((t) => fold(b.text).includes(fold(t))).length }))
      .sort((a, b) => b.s - a.s)[0]?.b
  const para = (req: string | undefined): { text: string; factIds: string[] } | null => {
    const first = (req ? best(req) : undefined) ?? bullets.find((x) => !used.has(x.id))
    if (!first) return null
    used.add(first.id)
    const second = bullets.find((x) => !used.has(x.id) && x.work.id === first.work.id)
    if (second) used.add(second.id)
    const lead = req ? `The posting asks for ${lowerFirst(req.replace(/\.$/, ''))}. ` : ''
    const text = `${lead}At ${first.work.company}, as ${first.work.title}, I ${lowerFirst(first.text.replace(/\.$/, ''))}.${second ? ` I also ${lowerFirst(second.text.replace(/\.$/, ''))}.` : ''}`
    return { text, factIds: [first.id, ...(second ? [second.id] : [])] }
  }
  const body = [para(met[0]?.text), para(met[1]?.text)].filter((x): x is NonNullable<typeof x> => !!x)
  const current = p.work[0]
  const skills = p.skills.map((sk) => sk.name).filter((sk) => fold(i.job.description).includes(fold(sk))).slice(0, 4)
  return {
    greeting: 'Dear Hiring Manager,',
    paragraphs: [
      {
        text: `I am applying for the ${i.job.title} role at ${i.job.company}.${current ? ` I am currently ${current.title} at ${current.company}, and much of the work in the posting matches what I do now.` : ''}${skills.length ? ` The tools you list, ${skills.join(', ').replace(/, ([^,]*)$/, ' and $1')}, are ones I use.` : ''}`,
        factIds: current ? [current.id] : [],
      },
      ...body,
      { text: `I would be glad to talk about how this experience could help your team. Thank you for reading.`, factIds: [] },
    ],
    closing: i.region === 'US' || i.region === 'CA' ? 'Best regards,' : 'Kind regards,',
  }
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s)

export function letterText(plan: LetterPlan, name: string): string {
  return [plan.greeting.trim(), '', ...plan.paragraphs.map((p) => p.text.trim()).flatMap((t) => [t, '']), plan.closing.trim(), name].join('\n').trim()
}

export type LetterResult = { text: string; plan: LetterPlan; issues: StyleIssue[] }

/** Writes a letter and checks it with the style guard; one rewrite if it fails. */
export async function writeLetter(ai: AiService, input: Omit<LetterInput, 'feedback'>, call: { signal?: AbortSignal | undefined; meter?: Meter | undefined } = {}): Promise<LetterResult> {
  let plan = await ai.structured(letterPrompt, input, { task: 'Write cover letter', ...call })
  let text = letterText(plan, input.profile.basics.name)
  let issues = styleCheck(text, 'letter')
  if (issues.length) {
    plan = await ai.structured(letterPrompt, { ...input, feedback: issues }, { task: 'Write cover letter (retry)', ...call })
    text = letterText(plan, input.profile.basics.name)
    issues = styleCheck(text, 'letter')
  }
  return { text, plan, issues }
}

// ---------------------------------------------------------------------------
// Keyword coverage

export function keywordCoverage(posting: string, judgmentKeywords: string[], resume: ResumeContent, profile: Profile): { present: string[]; inProfileNotResume: string[]; notInProfile: string[] } {
  const wanted = [...new Set([...judgmentKeywords.map((k) => canonicalTerm(k) ?? k), ...findTerms(posting)])]
  const resumeText = fold(resumeAsText(resume))
  const resumeTerms = new Set(findTerms(resumeAsText(resume)))
  const profileText = profileDigest(profile)
  const profileTerms = new Set(findTerms(profileText))
  const present: string[] = []
  const inProfileNotResume: string[] = []
  const notInProfile: string[] = []
  for (const k of wanted) {
    if (resumeTerms.has(k) || resumeText.includes(fold(k))) present.push(k)
    else if (profileTerms.has(k) || fold(profileText).includes(fold(k))) inProfileNotResume.push(k)
    else notInProfile.push(k)
  }
  return { present, inProfileNotResume, notInProfile }
}
