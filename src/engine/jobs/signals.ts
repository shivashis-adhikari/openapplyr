import type { Signal } from '../../shared/domain'

type Rule = { re: RegExp; label: string }

const FREE_MAIL = /\b[\w.+-]+@(gmail|yahoo|hotmail|outlook|live|aol|icloud|protonmail|proton|gmx|mail|yandex|zoho)\.[a-z.]+\b/i

const SCAM: Rule[] = [
  { re: /\b(purchase|buy)\b[^.]{0,60}\b(equipment|laptop|software|supplies)\b[^.]{0,60}\b(reimburs|check|cheque)/i, label: 'Asks you to buy equipment for reimbursement' },
  { re: /\b(send|deposit|cash)\b[^.]{0,30}\b(check|cheque|money order)\b/i, label: 'Mentions depositing a check' },
  { re: /\b(gift cards?|wire transfer|western union|moneygram|bitcoin|crypto(currency)? wallet)\b/i, label: 'Mentions gift cards, wire transfers or crypto' },
  { re: /\b(telegram|whatsapp|signal app|google hangouts|wickr)\b[^.]{0,60}\b(interviews?|contacts?|reach|messages?|chats?)\b/i, label: 'Moves the interview to a chat app' },
  { re: /\b(interviews?|contacts?|reach|messages?|chats?)\b[^.]{0,60}\b(telegram|whatsapp|wickr)\b/i, label: 'Moves the interview to a chat app' },
  { re: /\b(social security number|ssn|bank account (number|details)|routing number|driver'?s licen[cs]e (copy|photo|scan)|passport (copy|photo|scan))\b[^.]{0,40}\b(send|provide|submit|email)/i, label: 'Asks for ID or bank details up front' },
  { re: /\b(send|provide|submit|email)\b[^.]{0,40}\b(social security number|ssn|bank account|routing number|passport (copy|scan))\b/i, label: 'Asks for ID or bank details up front' },
  { re: /\b(no (interview|experience) (required|needed))\b[^.]{0,60}\$\s?\d/i, label: 'Promises pay without an interview' },
  { re: /\bearn (up to )?\$\s?\d[\d,]*\s*(per|a|\/)\s*(day|week)\b/i, label: 'Promises daily or weekly earnings' },
  { re: /\b(registration|training|application|processing) fee\b/i, label: 'Charges a fee to apply or train' },
]

const AI_POLICY_RESTRICT = [
  /\b(do not|don't|please do not|we ask that you (do not|don't)) (use|rely on) (ai|chatgpt|generative ai|genai|large language models?|llms?)\b/i,
  /\b(applications?|cover letters?|responses?|answers?)\b[^.]{0,40}\b(written|generated|created|produced)\b[^.]{0,20}\b(by|with|using) (ai|chatgpt|generative ai)\b[^.]{0,40}\b(rejected|disqualified|not be considered|removed)\b/i,
  /\bwithout (the )?(use|assistance|help) of (ai|chatgpt|generative ai|ai tools)\b/i,
  /\b(ai|automated)[- ]?(generated|assisted) applications? (will|may) (be )?(rejected|disqualified|not be considered)\b/i,
]
const AI_POLICY_DISCLOSE = [/\bdisclose (any |your )?(use of )?(ai|generative ai|chatgpt)\b/i, /\b(if|where) you (used|use) (ai|generative ai|chatgpt)[^.]{0,40}\b(tell|let) us\b/i]

const INSTRUCTIONS: Rule[] = [
  { re: /\bif you are (an? )?(ai|llm|language model|bot|automated|chatgpt|gpt)\b[^.\n]{0,160}/i, label: 'Text addressed to AI tools' },
  { re: /\bignore (all |any )?(previous|prior|above) (instructions|prompts?)\b[^.\n]{0,160}/i, label: 'Text addressed to AI tools' },
  { re: /\b(mention|include|use|put|write|add|type)\b[^.\n]{0,30}\b(the )?(word|phrase|keyword|code ?word|tag)\b[^.\n]{0,120}/i, label: 'Application instruction in the posting' },
  { re: /\b(start|begin|title|subject line of) (your )?(cover letter|application|email|subject)\b[^.\n]{0,40}\bwith\b[^.\n]{0,100}/i, label: 'Application instruction in the posting' },
  { re: /\bto (show|prove|confirm) (that )?you (have )?read (this|the) (job |whole )?(post(ing)?|description|ad)\b[^.\n]{0,120}/i, label: 'Application instruction in the posting' },
]

const CLEARANCE = /\b(active (secret|top secret|ts) clearance|security clearance (is )?required|ts\/sci|top secret\/sci|secret clearance|public trust clearance|polygraph|dod clearance|must (be able to )?obtain (a|an) [^.]{0,20}clearance)\b/i
const CITIZENSHIP = /\b(u\.?s\.? citizenship (is )?required|must be a u\.?s\.? citizen|us citizens only|only u\.?s\.? citizens)\b/i
const NO_SPONSOR = /\b((unable|not able|cannot|can't|won't|will not|do not|don't|does not|doesn't|is not able to) (to )?(provide |offer )?(visa )?sponsor(ship)?|no (visa )?sponsorship|sponsorship (is )?not (available|provided|offered)|without (the need for )?(current or future )?(visa )?sponsorship|not eligible for (visa )?sponsorship)\b/i
const SPONSOR = /\b((visa )?sponsorship (is )?(available|provided|offered)|we (can |will |do )?sponsor (visas|work visas|h-?1b)|will sponsor|open to sponsor(ing)?|h-?1b (transfer|sponsorship) (available|welcome))\b/i

function quote(text: string, m: RegExpExecArray): string {
  const start = Math.max(0, text.lastIndexOf('\n', m.index) + 1)
  const endNl = text.indexOf('\n', m.index + m[0].length)
  const end = endNl < 0 ? text.length : endNl
  const line = text.slice(start, end).trim()
  return line.length > 240 ? `${m[0].trim().slice(0, 237)}…` : line
}

export type SignalInput = {
  description: string
  company: string
  companyDomain?: string | null
  postedAt?: number | null
  repostCount?: number
  staffing?: boolean
  now?: number
}

/** Deterministic signals from the posting text. The model adds its own reading during scoring. */
export function detectSignals(i: SignalInput): Signal[] {
  const out: Signal[] = []
  const text = i.description
  const add = (s: Signal) => {
    if (!out.some((o) => o.kind === s.kind && o.label === s.label)) out.push(s)
  }
  for (const r of SCAM) {
    const m = r.re.exec(text)
    if (m) add({ kind: 'scam', severity: 'block', label: r.label, detail: quote(text, m) })
  }
  const mail = FREE_MAIL.exec(text)
  if (mail && i.companyDomain && !mail[0].toLowerCase().endsWith(i.companyDomain.toLowerCase())) {
    add({ kind: 'scam', severity: 'warn', label: 'Contact uses a personal email address', detail: mail[0] })
  }
  for (const re of AI_POLICY_RESTRICT) {
    const m = re.exec(text)
    if (m) add({ kind: 'ai_policy', severity: 'block', label: 'Employer restricts AI-assisted applications', detail: quote(text, m) })
  }
  for (const re of AI_POLICY_DISCLOSE) {
    const m = re.exec(text)
    if (m) add({ kind: 'ai_policy', severity: 'warn', label: 'Employer asks you to disclose AI use', detail: quote(text, m) })
  }
  for (const r of INSTRUCTIONS) {
    const m = r.re.exec(text)
    if (m) add({ kind: 'instructions', severity: 'warn', label: r.label, detail: quote(text, m) })
  }
  let m = CLEARANCE.exec(text)
  if (m) add({ kind: 'clearance', severity: 'warn', label: 'Security clearance required', detail: quote(text, m) })
  m = CITIZENSHIP.exec(text)
  if (m) add({ kind: 'clearance', severity: 'warn', label: 'Citizenship required', detail: quote(text, m) })
  m = NO_SPONSOR.exec(text)
  if (m) add({ kind: 'no_sponsorship', severity: 'info', label: 'States no visa sponsorship', detail: quote(text, m) })
  else {
    m = SPONSOR.exec(text)
    if (m) add({ kind: 'sponsorship', severity: 'info', label: 'Offers visa sponsorship', detail: quote(text, m) })
  }
  if (i.staffing) add({ kind: 'staffing', severity: 'info', label: 'Posted by a staffing agency', detail: i.company })
  const now = i.now ?? Date.now()
  if (i.postedAt && now - i.postedAt > 60 * 86_400_000) {
    add({ kind: 'stale', severity: 'warn', label: `Posted ${Math.round((now - i.postedAt) / 86_400_000)} days ago`, detail: 'Older postings are often filled or inactive.' })
  }
  if ((i.repostCount ?? 0) >= 3) {
    add({ kind: 'ghost', severity: 'warn', label: `Reposted ${i.repostCount} times`, detail: 'Roles that keep being reposted are often not actively hiring.' })
  }
  return out
}

/** Signals that keep a job out of autopilot. */
export function blocksAutopilot(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.severity === 'block' || s.kind === 'instructions' || s.kind === 'ai_policy' || s.kind === 'ghost' || s.kind === 'scam')
}
