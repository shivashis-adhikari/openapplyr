import { z } from 'zod'
import type { Judgment, Profile, StyleIssue } from '../../shared/domain'
import { NO_INVENTION_RULE, block, definePrompt, untrusted } from '../ai/prompt'
import type { AiService, Meter } from '../ai/service'
import { numbersIn } from '../docs/factlock'
import { STYLE_RULES_FOR_PROMPTS, styleCheck } from '../docs/styleguard'
import { profileDigest } from '../profile/digest'

export const PURPOSES = ['recruiter_intro', 'hiring_manager', 'referral', 'follow_up', 'thank_you', 'linkedin_note', 'linkedin_message'] as const
export type Purpose = (typeof PURPOSES)[number]

export const OPT_OUT_LINE = "If this isn't relevant, tell me and I won't follow up."

export type DraftInput = {
  profile: Profile
  voice: string
  purpose: Purpose
  contact: { name: string; title: string | null }
  job: { title: string; company: string; description: string }
  judgment: Judgment | null
  applied: boolean
  notes?: string | undefined
  feedback?: string[] | undefined
}

const DraftSchema = z.object({ subject: z.string().max(120), body: z.string().min(20).max(2400), factIds: z.array(z.string()) })
export type Draft = z.infer<typeof DraftSchema>

const PURPOSE_BRIEF: Record<Purpose, string> = {
  recruiter_intro: 'A first note to a recruiter at the company about the role. Say which role, one or two matching facts, and ask whether they are the right person or could pass it on.',
  hiring_manager: 'A first note to the person who likely manages this role. Connect one requirement from the posting to one result from the profile. Ask for a short conversation. The resume is attached.',
  referral: 'A request to someone at the company for a referral or a pointer to the hiring team. Make it easy to say yes or no.',
  follow_up: 'A short follow-up after applying. Name the role and the application date, add one new relevant fact, ask about next steps.',
  thank_you: 'A thank-you after an interview. Refer to something specific from the notes, restate fit in one sentence.',
  linkedin_note: 'A LinkedIn connection note. At most 280 characters. No subject.',
  linkedin_message: 'A LinkedIn message to a first-degree connection. At most 90 words. No subject.',
}

export const draftPrompt = definePrompt<DraftInput, Draft>({
  id: 'outreach.draft',
  version: 1,
  role: 'writer',
  system:
    "You write short, specific messages that a job seeker sends from their own mailbox under their own name. Every claim about them comes from their profile; everything about the company comes from the posting. Busy people read the first two lines only, so the point goes there.",
  describe: 'A message draft.',
  maxOutputTokens: 800,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 6000)}`),
      block('candidate_profile', profileDigest(i.profile, { contact: true })),
      i.judgment ? block('strongest_matches', i.judgment.requirements.filter((r) => r.verdict === 'met').slice(0, 5).map((r) => `- ${r.text} (facts ${r.evidence.join(', ')})`).join('\n')) : '',
      i.voice ? block('candidate_voice', i.voice) : '',
      i.notes ? untrusted('interview notes', i.notes) : '',
      i.feedback?.length ? block('fix_these', i.feedback.map((f) => `- ${f}`).join('\n')) : '',
      block(
        'instructions',
        [
          NO_INVENTION_RULE,
          `Recipient: ${i.contact.name}${i.contact.title ? `, ${i.contact.title}` : ''}. Address them by first name.`,
          `Purpose: ${PURPOSE_BRIEF[i.purpose]}`,
          i.applied ? 'The candidate has already applied through the company\'s site.' : 'The candidate has not applied yet.',
          'Plain text. 60 to 110 words for email. Sign with the candidate\'s first name. List the fact ids you used.',
          'Subject: specific and short, like "Backend role: payments experience". Never "Quick question" or "Following up".',
          STYLE_RULES_FOR_PROMPTS,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n'),
  schema: DraftSchema,
  mock: (i) => heuristicDraft(i),
})

function heuristicDraft(i: DraftInput): Draft {
  const first = i.contact.name.split(/\s+/)[0] ?? i.contact.name
  const me = i.profile.basics.name.split(/\s+/)[0] ?? i.profile.basics.name
  const w = i.profile.work[0]
  const fact = w?.bullets[0]
  const line = fact ? `At ${w!.company} I ${fact.text.charAt(0).toLowerCase()}${fact.text.slice(1).replace(/\.$/, '')}.` : ''
  const ask: Record<Purpose, string> = {
    recruiter_intro: `Are you the right person to talk to about it, or could you point me to them?`,
    hiring_manager: `Would you be open to a short call? My resume is attached.`,
    referral: `Would you be willing to refer me, or point me to the hiring team? A no is completely fine.`,
    follow_up: `Is there anything else I can send to help with the review?`,
    thank_you: `Thank you for your time. I would be glad to continue the conversation.`,
    linkedin_note: '',
    linkedin_message: `Would you be open to a short chat about the team?`,
  }
  if (i.purpose === 'linkedin_note') {
    return { subject: '', body: `Hi ${first}, I'm ${i.applied ? 'applying' : 'looking at'} the ${i.job.title} role at ${i.job.company}. ${line}`.slice(0, 280), factIds: fact ? [fact.id] : [] }
  }
  const opening = i.purpose === 'thank_you' ? `Thank you for talking with me about the ${i.job.title} role.` : `I ${i.applied ? 'applied for' : 'am interested in'} the ${i.job.title} role at ${i.job.company}.`
  return {
    subject: i.purpose === 'thank_you' ? `Thank you: ${i.job.title} interview` : `${i.job.title} role${w ? `: ${w.title} at ${w.company}` : ''}`,
    body: [`Hi ${first},`, `${opening} ${line}`.trim(), ask[i.purpose], me].join('\n\n'),
    factIds: fact ? [fact.id] : [],
  }
}

/** Numbers in a draft must appear in the profile or the posting: no invented metrics in anyone's inbox. */
export function unsupportedNumbers(body: string, profile: Profile, posting: string): string[] {
  const allowed = new Set([...numbersIn(profileDigest(profile, { contact: true })), ...numbersIn(posting)])
  // Meeting lengths ("a 20-minute call") are requests, not claims about the candidate.
  const claims = body.replace(/\b\d+[- ]?(minute|min|hour)s?\b[- ](call|chat|conversation|meeting)/gi, '')
  return [...numbersIn(claims)].filter((n) => !allowed.has(n))
}

export type DraftResult = Draft & { issues: StyleIssue[] }

export async function writeDraft(ai: AiService, input: Omit<DraftInput, 'feedback'>, call: { signal?: AbortSignal | undefined; meter?: Meter | undefined } = {}): Promise<DraftResult> {
  const check = (d: Draft) => {
    const issues = styleCheck(d.body, input.purpose.startsWith('linkedin') ? 'answer' : 'email')
    const nums = unsupportedNumbers(d.body, input.profile, input.job.description)
    if (nums.length) issues.push({ rule: 'fact', excerpt: nums.join(', '), message: `These numbers are not in your profile or the posting: ${nums.join(', ')}.` })
    if (input.purpose === 'linkedin_note' && d.body.length > 300) issues.push({ rule: 'length', excerpt: `${d.body.length} characters`, message: 'LinkedIn notes are limited to 300 characters.' })
    return issues
  }
  let d = await ai.structured(draftPrompt, input, { task: 'Draft message', ...call })
  let issues = check(d)
  if (issues.length) {
    d = await ai.structured(draftPrompt, { ...input, feedback: issues.map((x) => x.message) }, { task: 'Draft message (retry)', ...call })
    issues = check(d)
  }
  return { ...d, issues }
}

/** Follow-ups are short and fixed in shape; they always carry the opt-out line. */
export function followUpText(step: 1 | 2, o: { contactName: string; senderName: string; title: string; company: string; appliedOn: string | null }): string {
  const first = o.contactName.split(/\s+/)[0] ?? o.contactName
  const me = o.senderName.split(/\s+/)[0] ?? o.senderName
  const middle =
    step === 1
      ? `Following up on my note about the ${o.title} role at ${o.company}. If it helps, I can send more detail on any part of my background.`
      : `One last note about the ${o.title} role.${o.appliedOn ? ` I applied on ${o.appliedOn}` : ' I am still interested'} and would welcome a short call if the team is hiring.`
  return [`Hi ${first},`, middle, OPT_OUT_LINE, me].join('\n\n')
}
