import type { AnswerKind } from '../../shared/domain'
import { fold } from '../util/text'

/** A field on an application form, from an ATS API or read from the page. */
export type FormQuestion = {
  fieldName: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'multiselect' | 'radio' | 'checkbox' | 'file' | 'date' | 'number' | 'email' | 'tel' | 'url'
  required: boolean
  options: string[]
  description?: string | undefined
  maxLength?: number | undefined
}

export type Classified = { key: string; kind: AnswerKind; confidence: number }

type Rule = { key: string; kind: AnswerKind; re: RegExp; types?: FormQuestion['type'][] }

/**
 * Canonical questions. Order matters: specific patterns come before general ones.
 * Keys that start with "authorized:" or "skill_years:" carry a parameter (country or skill).
 */
const RULES: Rule[] = [
  { key: 'resume', kind: 'file', re: /\b(resume|cv|curriculum vitae)\b/, types: ['file'] },
  { key: 'cover_letter_file', kind: 'file', re: /\bcover letter\b/, types: ['file'] },
  { key: 'cover_letter', kind: 'open', re: /\bcover letter\b/, types: ['textarea', 'text'] },
  { key: 'first_name', kind: 'contact', re: /^(legal )?first name|^given name|^forename/ },
  { key: 'last_name', kind: 'contact', re: /^(legal )?last name|^surname|^family name/ },
  { key: 'preferred_name', kind: 'contact', re: /\bpreferred (first )?name\b/ },
  { key: 'full_name', kind: 'contact', re: /^(full |legal )?name\b/ },
  { key: 'email', kind: 'contact', re: /\be-?mail\b/ },
  { key: 'phone', kind: 'contact', re: /\b(phone|mobile|telephone|cell)\b/ },
  { key: 'linkedin', kind: 'contact', re: /\blinked ?in\b/ },
  { key: 'github', kind: 'contact', re: /\bgithub\b/ },
  { key: 'portfolio', kind: 'contact', re: /\b(portfolio|website|personal site|blog|other (url|link|website))\b/ },
  { key: 'postal_code', kind: 'contact', re: /\b(zip|postal) ?code\b/ },
  { key: 'address', kind: 'contact', re: /^(street |home |mailing )?address\b|\b(street|home|mailing) address\b/ },
  // Legal questions before location ones: "authorized to work in the location(s) you selected" is not a location field.
  { key: 'sponsorship', kind: 'legal', re: /\b(sponsor(ship)?|visa|h-?1b|work permit)\b.*\b(require|need)|\b(require|need)\b.*\b(sponsor(ship)?|visa)/ },
  { key: 'authorized', kind: 'legal', re: /\b(legally )?(authori[sz]ed|eligible|entitled|right) to work\b|\bwork authori[sz]ation\b|\bright to work\b/ },
  { key: 'visa_status', kind: 'legal', re: /\b(visa|work permit|residence permit|immigration) (status|situation|type)\b|\bwhich visa\b/ },
  { key: 'work_country', kind: 'fact', re: /\bcountr(y|ies) .*\b(anticipate|expect|plan|intend|would like) (to be )?work(ing)? in\b|\b(anticipate|expect|plan) (to be )?working in\b/ },
  { key: 'location_country', kind: 'contact', re: /^country\b|\bcountry (of|you) (residence|currently live|live in)|\b(what|which) country do you (currently )?live|\bcountry (where|in which) you (currently )?(reside|live)\b/ },
  { key: 'location_city', kind: 'contact', re: /^(current |your )?(city|location)\b(?!.*(relocat|willing))|\b(what|which) city\b|\bwhere are you (currently )?(located|based)\b|\bcity of residence\b/ },
  { key: 'over_18', kind: 'legal', re: /\b(18|eighteen) (years|or older)|\bat least 18\b|\bof legal (working )?age\b/ },
  { key: 'clearance', kind: 'legal', re: /\b(security )?clearance\b/ },
  { key: 'drivers_license', kind: 'legal', re: /\bdriver'?s? licen[cs]e\b/ },
  { key: 'criminal', kind: 'legal', re: /\b(convicted|conviction|criminal|felony|misdemeanor)\b/ },
  { key: 'non_compete', kind: 'legal', re: /\bnon-?(compete|solicitation)\b/ },
  { key: 'background_check', kind: 'legal', re: /\bbackground (check|screening)\b/ },
  { key: 'citizenship', kind: 'legal', re: /\bcitizen(ship)?\b/ },
  { key: 'previously_employed', kind: 'fact', re: /\b(previously|ever|formerly) (been )?(worked|employed) (at|for|by|with)\b|\bformer employee\b/ },
  { key: 'relatives', kind: 'legal', re: /\b(relative|family member)s? (who )?(work|employed)\b/ },
  { key: 'salary_current', kind: 'salary', re: /\b(current|present) (salary|compensation|ctc|pay)\b|\bcurrent ctc\b/ },
  { key: 'salary_expected', kind: 'salary', re: /\b(salary|compensation|pay|ctc)\b.*\b(expect|desire|requirement|range|looking for)|\bexpected (salary|ctc|compensation)\b|\bdesired (salary|pay)\b/ },
  { key: 'notice_period', kind: 'fact', re: /\bnotice period\b/ },
  { key: 'start_date', kind: 'fact', re: /\b(start date|when can you start|earliest (start|date)|available to start|availability)\b/ },
  { key: 'relocation', kind: 'fact', re: /\b(relocat|willing to move)/ },
  { key: 'travel', kind: 'fact', re: /\bwilling to travel|\btravel (up to|requirement)/ },
  { key: 'onsite_ok', kind: 'fact', re: /\b(able|willing) to (work|commute)\b.*\b(office|on-?site|hybrid|in person)/ },
  { key: 'skill_years', kind: 'computed', re: /\b(how many )?years\b.*\b(experience)\b.*\b(with|in|using)\b/ },
  { key: 'years_experience', kind: 'computed', re: /\b(how many )?years of (professional |relevant |work )?experience\b/ },
  { key: 'current_employer', kind: 'fact', re: /\b(current|most recent|previous) (employer|company)\b/ },
  { key: 'current_title', kind: 'fact', re: /\b(current|most recent|previous) (job )?(title|position|role)\b/ },
  { key: 'degree', kind: 'fact', re: /\b(highest )?(degree|level of education|education level)\b/ },
  { key: 'school', kind: 'fact', re: /\b(school|university|college|institution)\b/ },
  { key: 'graduation', kind: 'fact', re: /\bgraduat(ion|ed)\b.*\b(year|date)\b/ },
  { key: 'languages', kind: 'fact', re: /\b(language|fluen)/ },
  { key: 'referral', kind: 'fact', re: /\b(referred|referral)\b/ },
  { key: 'how_heard', kind: 'choice', re: /\bhow did you (hear|find|learn)\b|\bsource\b/ },
  { key: 'gender', kind: 'eeo', re: /\bgender\b|\bsex\b/ },
  { key: 'hispanic', kind: 'eeo', re: /\bhispanic|latin[oax]\b/ },
  { key: 'race', kind: 'eeo', re: /\brace\b|\bethnic/ },
  { key: 'veteran', kind: 'eeo', re: /\bveteran\b/ },
  { key: 'disability', kind: 'eeo', re: /\bdisabilit/ },
  { key: 'pronouns', kind: 'eeo', re: /\bpronouns?\b/ },
  { key: 'sexual_orientation', kind: 'eeo', re: /\bsexual orientation\b|\blgbt/ },
  { key: 'consent_privacy', kind: 'consent', re: /\b(privacy (policy|notice)|data (processing|protection)|gdpr|consent|i agree|i acknowledge|i certify|i confirm)\b/, types: ['checkbox', 'radio', 'select'] },
  { key: 'why_company', kind: 'open', re: /\bwhy (do you want|are you interested|would you like) (to work )?(at|for|with|in joining)?|\bwhat (interests|excites|draws) you\b|\bwhy (this|our) (company|role|team)\b/ },
  { key: 'additional_info', kind: 'open', re: /\b(anything else|additional information|tell us more|is there anything)\b/ },
]

// Matched against the original label: "US" and "UK" are case-sensitive so "tell us" is not the United States.
const COUNTRY_WORDS: [RegExp, string][] = [
  [/\b(united states|america)\b|\bU\.S\.(A\.)?|\bUSA?\b/i, 'US'],
  [/\b(united kingdom|britain|england)\b|\bU\.K\.|\bUK\b/i, 'GB'],
  [/\bcanada\b/i, 'CA'],
  [/\bindia\b/i, 'IN'],
  [/\b(germany|deutschland)\b/i, 'DE'],
  [/\b(netherlands|holland)\b/i, 'NL'],
  [/\baustralia\b/i, 'AU'],
  [/\bireland\b/i, 'IE'],
  [/\bfrance\b/i, 'FR'],
  [/\bspain\b/i, 'ES'],
  [/\bportugal\b/i, 'PT'],
  [/\bsingapore\b/i, 'SG'],
  [/\b(european union|european economic area)\b|\bEU\b|\bEEA\b/i, 'EU'],
]

export function countryInQuestion(label: string): string | null {
  for (const [re, code] of COUNTRY_WORDS) {
    // Short codes only count when written in capitals in the label.
    const hits = label.match(new RegExp(re.source, 'gi')) ?? []
    if (hits.some((h) => h.length > 4 || h === h.toUpperCase())) return code
  }
  return null
}

/** Deterministic classification. Returns null for questions only the model or the user can place. */
export function classifyQuestion(q: Pick<FormQuestion, 'label' | 'type' | 'options'>): Classified | null {
  const label = fold(q.label).replace(/\*/g, '').trim()
  if (!label) return null
  for (const r of RULES) {
    if (r.types && !r.types.includes(q.type)) continue
    if (r.re.test(label)) {
      if (r.key === 'authorized') return { key: `authorized:${countryInQuestion(q.label) ?? 'job'}`, kind: 'legal', confidence: 0.95 }
      if (r.key === 'skill_years') {
        const m = /\b(?:with|in|using)\s+(.+)$/.exec(label)
        const skill = m?.[1]!.replace(/^(the |a |an )/, '').trim() ?? ''
        if (!skill || /^(total|overall|all|general|professional|industry|this (field|industry|role)|the (field|industry)|a similar role|similar roles)\b/.test(skill)) {
          return { key: 'years_experience', kind: 'computed', confidence: 0.8 }
        }
        return { key: `skill_years:${skill}`, kind: 'computed', confidence: 0.85 }
      }
      return { key: r.key, kind: r.kind, confidence: 0.95 }
    }
  }
  if (q.type === 'textarea') return { key: `open:${label.slice(0, 80)}`, kind: 'open', confidence: 0.6 }
  return null
}

const DECLINE = /(decline|prefer not|don'?t wish|do not wish|choose not|not to (say|disclose|answer|self-identify)|rather not)/i

/** Picks the option that best matches an intended answer: exact, then "decline", yes/no, then word overlap. */
export function pickOption(options: string[], wanted: string): string | null {
  if (!options.length) return null
  const w = fold(wanted)
  const exact = options.find((o) => fold(o) === w)
  if (exact) return exact
  if (DECLINE.test(wanted)) return options.find((o) => DECLINE.test(o)) ?? null
  if (/^(yes|y|true)$/i.test(wanted.trim())) return options.find((o) => /^(yes|y\b|true|i am|i do|i have|i will)/i.test(o.trim())) ?? null
  if (/^(no|n|false)$/i.test(wanted.trim())) return options.find((o) => /^(no\b|n\b|false|i am not|i do not|i don'?t|i have not|i will not)/i.test(o.trim())) ?? null
  const starts = options.find((o) => fold(o).startsWith(w) || w.startsWith(fold(o)))
  if (starts) return starts
  const ww = new Set(w.split(' '))
  let best: { o: string; s: number } | null = null
  for (const o of options) {
    const ow = fold(o).split(' ')
    const s = ow.filter((x) => ww.has(x)).length / Math.max(ow.length, 1)
    if (s > (best?.s ?? 0)) best = { o, s }
  }
  return best && best.s >= 0.5 ? best.o : null
}
