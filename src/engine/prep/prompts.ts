import { z } from 'zod'
import type { Profile } from '../../shared/domain'
import { NO_INVENTION_RULE, block, definePrompt, untrusted } from '../ai/prompt'
import { STYLE_RULES_FOR_PROMPTS } from '../docs/styleguard'
import { findTerms } from '../jobs/terms'
import { profileDigest } from '../profile/digest'

export type InterviewKind = 'recruiter' | 'technical' | 'behavioral' | 'onsite' | 'final' | 'other'
type Job = { title: string; company: string; description: string }

// ---------------------------------------------------------------------------
// Company brief: every point carries the URL it came from.

const BriefSchema = z.object({
  sections: z.array(z.object({ heading: z.string(), points: z.array(z.object({ text: z.string(), source: z.string() })).max(8) })).max(6),
})
export type Brief = z.infer<typeof BriefSchema>

export const briefPrompt = definePrompt<{ job: Job; sources: { url: string; text: string }[] }, Brief>({
  id: 'prep.brief',
  version: 1,
  role: 'writer',
  system: 'You prepare a job candidate for an interview with short, sourced notes about the company. Each point must come from one of the sources and name it.',
  describe: 'A sourced company brief.',
  maxOutputTokens: 1800,
  user: (i) =>
    [
      ...i.sources.map((s) => untrusted(`source ${s.url}`, s.text.slice(0, 7000))),
      block(
        'instructions',
        [
          `Write a brief on ${i.job.company} for an interview for ${i.job.title}.`,
          'Sections: What they do; Products and customers; The team and this role; Recent news (only if a source mentions it); Things worth asking about.',
          'Each point: one sentence, with source set to the exact URL of the source it came from (or "posting"). Leave a section out rather than guess.',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: BriefSchema,
  mock: (i) => ({
    sections: [
      { heading: 'The team and this role', points: i.job.description.split(/\n+/).filter((l) => l.trim().length > 30).slice(0, 4).map((text) => ({ text: text.replace(/^[-*#\s]+/, '').slice(0, 200), source: 'posting' })) },
    ],
  }),
})

/** Drops points whose source was not one of the pages we actually fetched. */
export function sourcedOnly(b: Brief, urls: string[]): Brief {
  const ok = new Set([...urls, 'posting'])
  return { sections: b.sections.map((s) => ({ ...s, points: s.points.filter((p) => ok.has(p.source)) })).filter((s) => s.points.length) }
}

// ---------------------------------------------------------------------------
// Likely questions, questions to ask, and a logistics checklist.

const QuestionsSchema = z.object({
  likely: z.array(z.object({ question: z.string(), why: z.string(), factIds: z.array(z.string()) })).max(15),
  ask: z.array(z.string()).max(8),
  checklist: z.array(z.string()).max(10),
})
export type PrepQuestions = z.infer<typeof QuestionsSchema>

export const questionsPrompt = definePrompt<{ job: Job; profile: Profile; kind: InterviewKind }, PrepQuestions>({
  id: 'prep.questions',
  version: 1,
  role: 'writer',
  system: 'You help a candidate prepare for a specific interview. Questions come from the posting\'s requirements and the interview type; answers they could draw on come from their own profile.',
  describe: 'Interview questions and a checklist.',
  maxOutputTokens: 2000,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 8000)}`),
      block('candidate_profile', profileDigest(i.profile)),
      block(
        'instructions',
        [
          `Interview type: ${i.kind}.`,
          'likely: 8 to 12 questions this interviewer is likely to ask, each with why (which requirement it probes) and the fact ids the candidate could use.',
          'ask: 5 questions the candidate could ask that show they read the posting. No generic questions like "What does a typical day look like?".',
          'checklist: logistics to confirm before the interview (time zone, link or address, who they meet, what to have open).',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: QuestionsSchema,
  mock: (i) => {
    const terms = findTerms(i.job.description).slice(0, 6)
    const facts = i.profile.work.flatMap((w) => w.bullets)
    const fact = (t: string) => facts.filter((b) => b.text.toLowerCase().includes(t.toLowerCase())).map((b) => b.id).slice(0, 2)
    return {
      likely: [
        ...terms.map((t) => ({ question: `Tell me about a time you used ${t} in production.`, why: `The posting asks for ${t}.`, factIds: fact(t) })),
        { question: `Why ${i.job.company}, and why this role now?`, why: 'Motivation.', factIds: [] },
        { question: 'Tell me about a project you are proud of and your part in it.', why: 'Ownership and impact.', factIds: facts.slice(0, 1).map((b) => b.id) },
      ],
      ask: [`How does the team decide what to build next for ${i.job.title.toLowerCase()} work?`, 'What would you want this person to have done in the first six months?', 'How is on-call or support work shared on the team?'],
      checklist: ['Confirm the time and time zone.', 'Open the meeting link or plan the route ahead of time.', 'Have your resume and the posting open.', 'Know who you are meeting and their roles.'],
    }
  },
})

// ---------------------------------------------------------------------------
// Story bank: STAR stories drafted from the fact bank, then edited by the user.

const StoriesSchema = z.object({
  stories: z.array(z.object({ title: z.string(), situation: z.string(), task: z.string(), action: z.string(), result: z.string(), factIds: z.array(z.string()).min(1), tags: z.array(z.string()).max(6) })).max(8),
})
export type DraftStory = z.infer<typeof StoriesSchema>['stories'][number]

export const storiesPrompt = definePrompt<{ profile: Profile }, z.infer<typeof StoriesSchema>>({
  id: 'prep.stories',
  version: 1,
  role: 'writer',
  system: 'You turn a candidate\'s own work history into interview stories in the STAR shape. The candidate will edit them; you do not add anything that is not in their profile.',
  describe: 'STAR stories.',
  maxOutputTokens: 3000,
  user: (i) =>
    [
      block('candidate_profile', profileDigest(i.profile)),
      block(
        'instructions',
        [
          NO_INVENTION_RULE,
          'Write up to 6 stories, one per strong result in the profile. Each: a short title, situation, task, action and result in first person, the fact ids used, and tags',
          '(leadership, conflict, failure, scale, deadline, ambiguity, mentoring, customer). Where the profile does not say something (the situation, for example), keep it short and general rather than invent.',
          STYLE_RULES_FOR_PROMPTS,
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: StoriesSchema,
  mock: (i) => ({
    stories: i.profile.work
      .flatMap((w) => w.bullets.map((b) => ({ w, b })))
      .slice(0, 4)
      .map(({ w, b }) => ({
        title: b.text.split(/\s+/).slice(0, 6).join(' '),
        situation: `At ${w.company}, as ${w.title}.`,
        task: 'I owned this piece of work.',
        action: b.text,
        result: b.text,
        factIds: [b.id],
        tags: /led|team/i.test(b.text) ? ['leadership'] : /cut|reduc/i.test(b.text) ? ['scale'] : [],
      })),
  }),
})

// ---------------------------------------------------------------------------
// Mock interview.

const TurnSchema = z.object({
  feedback: z
    .object({
      structure: z.object({ score: z.number().int().min(1).max(5), note: z.string() }),
      specificity: z.object({ score: z.number().int().min(1).max(5), note: z.string() }),
      relevance: z.object({ score: z.number().int().min(1).max(5), note: z.string() }),
      length: z.object({ score: z.number().int().min(1).max(5), note: z.string() }),
      stronger: z.string(),
    })
    .nullable(),
  next: z.string(),
})
export type MockTurn = z.infer<typeof TurnSchema>
export type MockMessage = { role: 'interviewer' | 'candidate'; text: string; feedback?: MockTurn['feedback'] }

const PERSONA: Record<InterviewKind, string> = {
  recruiter: 'a recruiter doing a first screen: motivation, background, logistics, salary expectations',
  technical: 'an engineer on the team: depth on the tools and problems in the posting, trade-offs, debugging',
  behavioral: 'a hiring manager asking behavioral questions: ownership, conflict, failure, influence',
  onsite: 'a panel interviewer mixing technical depth and collaboration',
  final: 'a senior leader: judgment, priorities, why this company',
  other: 'an interviewer for this role',
}

export const mockPrompt = definePrompt<{ job: Job; profile: Profile; kind: InterviewKind; history: MockMessage[] }, MockTurn>({
  id: 'prep.mock',
  version: 1,
  role: 'writer',
  system: 'You run a practice interview. You play the interviewer, then coach: after each answer, score it and show a stronger version built only from the candidate\'s own facts.',
  describe: 'Feedback and the next question.',
  maxOutputTokens: 1400,
  user: (i) =>
    [
      untrusted('job posting', `${i.job.title} at ${i.job.company}\n\n${i.job.description.slice(0, 6000)}`),
      block('candidate_profile', profileDigest(i.profile)),
      untrusted('interview so far', i.history.map((m) => `${m.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${m.text}`).join('\n\n') || '(not started)'),
      block(
        'instructions',
        [
          `You are ${PERSONA[i.kind]}.`,
          i.history.at(-1)?.role === 'candidate'
            ? 'feedback: score the last answer 1 to 5 on structure, specificity (numbers, names, their own part), relevance to the question, and length (about two minutes spoken is right), each with a one-line note. stronger: the same answer rewritten, using only facts from the profile.'
            : 'feedback: null.',
          'next: the next question, one at a time, following up on the answer when it left something open.',
          NO_INVENTION_RULE,
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: TurnSchema,
  mock: (i) => {
    const last = i.history.at(-1)
    const asked = i.history.filter((m) => m.role === 'interviewer').length
    const terms = findTerms(i.job.description)
    const next = asked === 0 ? `Walk me through your background and why the ${i.job.title} role at ${i.job.company}.` : terms[asked - 1] ? `Tell me about your experience with ${terms[asked - 1]}.` : 'Tell me about a disagreement with a teammate and how it ended.'
    if (last?.role !== 'candidate') return { feedback: null, next }
    const words = last.text.split(/\s+/).filter(Boolean).length
    const hasNumber = /\d/.test(last.text)
    const fact = i.profile.work[0]?.bullets[0]?.text
    return {
      feedback: {
        structure: { score: /\b(then|so|as a result|because)\b/i.test(last.text) ? 4 : 3, note: 'Lead with the result, then how you got there.' },
        specificity: { score: hasNumber ? 4 : 2, note: hasNumber ? 'Good use of a concrete number.' : 'Add a number or a name: what changed, by how much.' },
        relevance: { score: 3, note: 'Tie the answer back to what the question asked.' },
        length: { score: words < 40 ? 2 : words > 350 ? 2 : 4, note: words < 40 ? 'Too short to show your part.' : words > 350 ? 'Too long; cut the setup.' : 'About right.' },
        stronger: fact ? `${fact}. My part was the design and the rollout, and I would do it the same way again.` : last.text,
      },
      next,
    }
  },
})

// ---------------------------------------------------------------------------
// Negotiation and LinkedIn posts.

export const negotiationPrompt = definePrompt<{ profile: Profile; offer: Record<string, unknown>; target: string; others: Record<string, unknown>[]; voice: string }, { subject: string; body: string }>({
  id: 'career.negotiate',
  version: 1,
  role: 'writer',
  system: 'You draft a polite, specific counter-offer email. You use only the numbers the candidate gives; you never cite market data or invent a competing offer.',
  describe: 'A negotiation email.',
  maxOutputTokens: 900,
  user: (i) =>
    [
      block('offer', JSON.stringify(i.offer, null, 2)),
      i.others.length ? block('other_offers_the_candidate_has', JSON.stringify(i.others, null, 2)) : '',
      block('candidate_target', i.target || '(no target given: ask for room on the base salary without naming a number)'),
      block('candidate_profile', profileDigest(i.profile)),
      i.voice ? block('candidate_voice', i.voice) : '',
      block('instructions', ['Thank them, restate enthusiasm in one plain sentence, make the ask with the target, give one reason from the profile or the other offers, and close.', 'Under 170 words. Subject short.', STYLE_RULES_FOR_PROMPTS].join('\n')),
    ]
      .filter(Boolean)
      .join('\n\n'),
  schema: z.object({ subject: z.string().max(120), body: z.string().min(40).max(2000) }),
  mock: (i) => ({
    subject: `Offer: ${String(i.offer['title'] ?? 'role')}`,
    body: `Hi,\n\nThank you for the offer for the ${String(i.offer['title'] ?? '')} role. I am glad to be at this stage and want to make it work.\n\n${i.target ? `Would you be able to move the base salary to ${i.target}?` : 'Is there room to improve the base salary?'} ${i.others.length ? 'I have another offer I am weighing, and this would make the decision straightforward.' : 'That would let me accept with confidence.'}\n\nThank you for considering it.\n\n${i.profile.basics.name.split(/\s+/)[0] ?? ''}`,
  }),
})

export const linkedinPostPrompt = definePrompt<{ profile: Profile; topic: string; voice: string }, { text: string }>({
  id: 'career.post',
  version: 1,
  role: 'writer',
  system: 'You draft a LinkedIn post for the person, in their voice, about their own work. The person posts it themselves.',
  describe: 'A LinkedIn post.',
  maxOutputTokens: 900,
  user: (i) =>
    [
      block('candidate_profile', profileDigest(i.profile)),
      i.voice ? block('candidate_voice', i.voice) : '',
      untrusted('topic from the user', i.topic),
      block('instructions', [NO_INVENTION_RULE, '120 to 220 words. One idea, a concrete example from the profile, no hashtag walls (at most 3), no emoji lists.', STYLE_RULES_FOR_PROMPTS].join('\n')),
    ]
      .filter(Boolean)
      .join('\n\n'),
  schema: z.object({ text: z.string().min(40).max(3000) }),
  mock: (i) => {
    const b = i.profile.work[0]?.bullets[0]
    return { text: `${i.topic.trim().replace(/\.$/, '')}.\n\n${b ? `At ${i.profile.work[0]!.company}, we ${b.text.charAt(0).toLowerCase()}${b.text.slice(1).replace(/\.$/, '')}. The part that mattered most was agreeing on what to measure before changing anything.` : ''}\n\nWhat would you have measured first?`.trim() }
  },
})
