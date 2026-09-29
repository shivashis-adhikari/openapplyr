import { z } from 'zod'
import { block, definePrompt, untrusted } from '../ai/prompt'

export const MAIL_CATEGORIES = [
  'application_received',
  'rejection',
  'interview_request',
  'assessment',
  'offer',
  'recruiter_outreach',
  'positive_reply',
  'negative_reply',
  'neutral_reply',
  'out_of_office',
  'verification_code',
  'scheduling',
  'other',
] as const
export type MailCategory = (typeof MAIL_CATEGORIES)[number]

/** The parts of a message the pipeline looks at. Bodies are used in memory and not stored. */
export type MailInput = {
  from: string
  fromName: string
  to: string[]
  subject: string
  text: string
  date: number
  inReplyTo: string | null
  headers: Record<string, string>
}

export type Classification = {
  category: MailCategory
  confidence: number
  company: string | null
  role: string | null
  code: string | null
  returnDate: number | null
  by: 'rule' | 'model'
}

/** Senders used by applicant tracking and assessment systems for candidate mail. */
export const ATS_MAIL_DOMAINS = [
  'greenhouse-mail.io',
  'greenhouse.io',
  'hire.lever.co',
  'lever.co',
  'ashbyhq.com',
  'myworkday.com',
  'workday.com',
  'smartrecruiters.com',
  'smartrecruitersmail.com',
  'workablemail.com',
  'workable.com',
  'recruitee.com',
  'icims.com',
  'successfactors.com',
  'successfactors.eu',
  'taleo.net',
  'oraclecloud.com',
  'jobvite.com',
  'bamboohr.com',
  'breezy.hr',
  'teamtailor.com',
  'teamtailor-mail.com',
  'personio.de',
  'applytojob.com',
  'rippling.com',
  'hackerrank.com',
  'hackerrankforwork.com',
  'codility.com',
  'codesignal.com',
  'testgorilla.com',
  'calendly.com',
  'goodtime.io',
  'gem.com',
  'dover.com',
  'wellfound.com',
  'linkedin.com',
]

const domainOf = (addr: string) => addr.split('@')[1]?.toLowerCase().trim() ?? ''
export const isAtsDomain = (addr: string) => {
  const d = domainOf(addr)
  return ATS_MAIL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))
}

const JOB_SUBJECT = /\b(your application|application (received|update|status)|thank(s| you) for (applying|your (application|interest))|interview|assessment|coding (challenge|test)|take[- ]home|next steps|job offer|offer letter|candidate|recruit|position|role at|opportunity|verify your (email|account)|verification code)\b/i

/**
 * Code-only prefilter: only mail that could be about the search is considered; everything
 * else is dropped before anything is stored or sent to a model.
 */
export function prefilter(m: Pick<MailInput, 'from' | 'subject' | 'inReplyTo'>, known: { domains: Set<string>; contacts: Set<string>; sentIds: Set<string> }): boolean {
  const addr = m.from.toLowerCase()
  if (known.contacts.has(addr)) return true
  if (m.inReplyTo && known.sentIds.has(m.inReplyTo)) return true
  if (isAtsDomain(addr)) return true
  const d = domainOf(addr)
  if (d && [...known.domains].some((x) => d === x || d.endsWith(`.${x}`))) return true
  return JOB_SUBJECT.test(m.subject)
}

const REJECTION = /\b(unfortunately|regret to (inform|let you know)|not (be )?(moving|move) forward|decided (not to|to (move|go) forward with other|to pursue other)|will not be (moving|progressing|proceeding)|not been selected|position has (been|now been) filled|no longer (being )?consider|other candidates whose|we won'?t be moving|at this time we (have|will)|not a (fit|match) (at this time|for this role))\b/i
const OFFER = /\b(pleased to (extend|offer)|offer letter|job offer|formal offer|offer of employment)\b/i
const INTERVIEW = /\b(interview|phone screen|schedule (a|some) time|your availability|book a time|pick a time|chat with (the )?(team|hiring manager)|next round|onsite)\b/i
const ASSESSMENT = /\b(assessment|coding (challenge|test|exercise)|take[- ]home|hackerrank|codility|codesignal|testgorilla|technical (test|exercise))\b/i
const RECEIVED = /\b(thank(s| you) for (applying|your application|submitting)|application (has been )?(received|submitted)|we('ve| have) received your application|your application (to|for) .{1,80} (was|has been) (received|submitted|sent))\b/i
const VERIFY = /\b(verification code|verify your (email|account)|one[- ]time (pass)?code|security code|confirm your email|activate your account)\b/i
const OOO = /\b(out of (the )?office|automatic reply|auto[- ]?reply|away from (the office|my desk)|on (annual )?leave|ooo)\b/i
const OPT_OUT = /\b(unsubscribe|remove me|stop (emailing|contacting)|do not (contact|email)|don'?t (contact|email) me|not interested)\b/i

export function extractCode(text: string): string | null {
  const m = /\b(?:code|passcode|pin)\b[^0-9A-Z]{0,40}\b([0-9]{4,8}|[A-Z0-9]{6,8})\b/i.exec(text) ?? /\b([0-9]{6})\b/.exec(text)
  return m?.[1] ?? null
}

/** "I'm back on 14 October" / "returning Monday, Oct 14" / "until 2026-10-14". */
export function returnDate(text: string, now: number): number | null {
  const iso = /\b(?:until|back|return(?:ing)?)\b[^.\n]{0,40}?(\d{4}-\d{2}-\d{2})/i.exec(text)
  if (iso) return Date.parse(`${iso[1]}T09:00:00`)
  const m = /\b(?:until|back|return(?:ing)?)\b[^.\n]{0,40}?\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\b(?:until|back|return(?:ing)?)\b[^.\n]{0,40}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i.exec(text)
  if (!m) return null
  const mon = (m[2] ?? m[3])!.toLowerCase().slice(0, 3)
  const day = Number(m[1] ?? m[4])
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mon)
  const d = new Date(now)
  const at = new Date(d.getFullYear(), month, day, 9)
  if (at.getTime() < now - 86_400_000) at.setFullYear(at.getFullYear() + 1)
  return at.getTime()
}

/** Company named in ATS mail: "Thank you for applying to Acme", "Your application at Acme for ...". */
export function companyHint(subject: string, text: string): string | null {
  for (const s of [subject, text.slice(0, 600)]) {
    const m = /\b(?:applying|application|interest)\s+(?:to|at|with|for)\s+(?:the\s+)?(?:.{1,60}?\s+(?:role|position)\s+at\s+)?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/.exec(s) ?? /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s*[!.,-]/.exec(s)
    if (m) return m[1]!.replace(/[.,!]+$/, '').replace(/\s+(?:for|and|has|is|was)$/, '').trim()
  }
  return null
}

/**
 * Known patterns first; returns null when no rule is confident enough and the model should decide.
 * Order matters: a "thank you for your interest ... unfortunately" email is a rejection.
 */
export function classifyByRules(m: MailInput, now: number): Classification | null {
  const text = `${m.subject}\n${m.text.slice(0, 4000)}`
  const base = { company: companyHint(m.subject, m.text), role: null, code: null, returnDate: null, by: 'rule' as const }
  const auto = (m.headers['auto-submitted'] ?? '').toLowerCase()
  if ((auto && auto !== 'no') || OOO.test(m.subject)) {
    if (OOO.test(text)) return { ...base, category: 'out_of_office', confidence: 0.9, returnDate: returnDate(text, now) }
  }
  if (VERIFY.test(text)) {
    const code = extractCode(m.text)
    return { ...base, category: 'verification_code', confidence: code ? 0.9 : 0.75, code }
  }
  if (REJECTION.test(text)) return { ...base, category: 'rejection', confidence: 0.9 }
  if (OFFER.test(text)) return { ...base, category: 'offer', confidence: 0.85 }
  if (ASSESSMENT.test(text)) return { ...base, category: 'assessment', confidence: 0.85 }
  if (INTERVIEW.test(text) && !RECEIVED.test(m.subject)) return { ...base, category: 'interview_request', confidence: 0.8 }
  if (RECEIVED.test(text)) return { ...base, category: 'application_received', confidence: 0.9 }
  return null
}

export const isOptOut = (text: string) => OPT_OUT.test(text.slice(0, 1500))

const MailSchema = z.object({
  category: z.enum(MAIL_CATEGORIES),
  confidence: z.number().min(0).max(1),
  company: z.string().nullable(),
  role: z.string().nullable(),
})

export const classifyMailPrompt = definePrompt<MailInput, z.infer<typeof MailSchema>>({
  id: 'mail.classify',
  version: 1,
  role: 'fast',
  system: 'You sort a job seeker\'s email about their applications. You read one message and say what it is. When unsure, say so with a low confidence.',
  describe: 'The message category.',
  maxOutputTokens: 300,
  cache: true,
  user: (m) =>
    [
      untrusted('email', `From: ${m.fromName} <${m.from}>\nSubject: ${m.subject}\n\n${m.text.slice(0, 5000)}`),
      block(
        'instructions',
        [
          'category: application_received (confirms an application), rejection, interview_request (asks to schedule or holds an interview), assessment (a test or take-home), offer,',
          'recruiter_outreach (a recruiter reaching out first), positive_reply / negative_reply / neutral_reply (a person answering the candidate), out_of_office, verification_code,',
          'scheduling (logistics for an interview already agreed), other.',
          'company: the hiring company named in the message, or null. role: the job title, or null. confidence: 0 to 1.',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: MailSchema,
  mock: (m) => {
    const r = classifyByRules(m, m.date)
    return { category: r?.category ?? 'other', confidence: r ? r.confidence : 0.3, company: r?.company ?? null, role: null }
  },
})

export type IcsEvent = { start: number | null; end: number | null; location: string | null; link: string | null; summary: string | null; description: string | null }

const icsDate = (v: string | undefined): number | null => {
  if (!v) return null
  const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v)
  if (!m) return null
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1)
  return m[7] ? Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s) : new Date(+y!, +mo! - 1, +d!, +h, +mi, +s).getTime()
}

/** Reads the first VEVENT from an iCalendar invite: times, place and a meeting link. */
export function parseIcs(ics: string): IcsEvent | null {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '')
  const ev = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/.exec(unfolded)?.[1]
  if (!ev) return null
  const prop = (name: string) => {
    const m = new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, 'm').exec(ev)
    return m ? m[1]!.trim().replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1') : undefined
  }
  const location = prop('LOCATION') ?? null
  const description = prop('DESCRIPTION') ?? null
  const link = /https:\/\/[^\s"<>]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com|chime\.aws)[^\s"<>]*/i.exec(`${location ?? ''} ${prop('URL') ?? ''} ${description ?? ''}`)?.[0] ?? null
  return { start: icsDate(prop('DTSTART')), end: icsDate(prop('DTEND')), location, link, summary: prop('SUMMARY') ?? null, description }
}
