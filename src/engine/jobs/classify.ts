import type { ContractType, Employment, Seniority } from '../../shared/domain'
import { fold } from '../util/text'

/** Display title: trimmed, location and workplace tags removed ("Senior Engineer (Remote) - Berlin" -> "Senior Engineer"). */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .replace(/\s*[[(](remote|hybrid|on-?site|contract|full[- ]time|part[- ]time|m\/w\/d|f\/m\/d|w\/m\/d|m\/f\/d|all genders|h\/f|f\/h)[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–—|]\s+(remote|hybrid|on-?site)(\s*[-–—|].*)?$/i, '')
    .trim()
}

/** Comparison key for titles: folded, gender tags and parentheticals removed, common abbreviations expanded. */
export function titleKey(title: string): string {
  return fold(
    cleanTitle(title)
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\bsr\b\.?/gi, 'senior')
      .replace(/\bjr\b\.?/gi, 'junior')
      .replace(/\beng\b\.?/gi, 'engineer')
      .replace(/\bmgr\b\.?/gi, 'manager')
      .replace(/\bswe\b/gi, 'software engineer')
      .replace(/\bdev\b/gi, 'developer'),
  )
}

const LEVEL_NUM: Record<string, Seniority> = { i: 'junior', '1': 'junior', ii: 'mid', '2': 'mid', iii: 'senior', '3': 'senior', iv: 'staff', '4': 'staff', v: 'principal', '5': 'principal' }

/** Level stated in the title, or null when the title has no level marker. */
export function seniorityOf(title: string): Seniority | null {
  const t = ` ${titleKey(title)} `
  if (/\b(intern|internship|co-?op|trainee|apprentice|werkstudent)\b/.test(t)) return 'intern'
  if (/\b(chief|cto|ceo|cfo|coo|cmo|cpo|ciso|vp|vice president|svp|evp|president|partner)\b/.test(t)) return 'executive'
  if (/\b(director|head of)\b/.test(t)) return 'director'
  if (/\bprincipal\b/.test(t) || /\bdistinguished\b/.test(t) || /\bfellow\b/.test(t)) return 'principal'
  if (/\bstaff\b/.test(t)) return 'staff'
  if (/\b(manager|management)\b/.test(t) && !/\b(product|project|program|account|case|community|office|success|marketing manager)\b/.test(t)) return 'manager'
  if (/\b(lead|tech lead|team lead)\b/.test(t)) return 'lead'
  if (/\bsenior\b/.test(t)) return 'senior'
  if (/\b(junior|entry[ -]level|graduate|new grad|associate)\b/.test(t) && !/\bassociate (director|manager|principal|partner)\b/.test(t)) return 'junior'
  // Tech-ladder levels (L3 new grad ... L7 principal) differ from numeral levels (I, II, III).
  const l = /\bl([3-8])\b/.exec(t)
  if (l) return ({ '3': 'junior', '4': 'mid', '5': 'senior', '6': 'staff', '7': 'principal', '8': 'principal' } as Record<string, Seniority>)[l[1]!]!
  const lvl = / (i{1,3}|iv|v|[1-5])\s*$/.exec(t) ?? /\blevel\s?([1-5])\b/.exec(t)
  if (lvl) return LEVEL_NUM[lvl[1]!] ?? 'mid'
  return null
}

/** Adjacent levels for scoring: a senior engineer is a reasonable fit for staff roles and mid roles. */
export const SENIORITY_RANK: Record<Seniority, number> = { intern: 0, junior: 1, mid: 2, senior: 3, lead: 3.5, staff: 4, manager: 4, principal: 5, director: 5.5, executive: 6 }

export function employmentOf(hint: string | null | undefined, text = ''): Employment | null {
  const h = fold(`${hint ?? ''}`)
  const body = fold(text.slice(0, 4000))
  const both = `${h} ${body}`
  if (/\b(intern|internship|co-?op|werkstudent)\b/.test(h) || /\b(internship|intern program)\b/.test(fold(text.slice(0, 300)))) return 'internship'
  if (/\b(contract|contractor|freelance|c2c|corp to corp|1099|fixed[- ]term|contract[- ]to[- ]hire)\b/.test(h)) return 'contract'
  if (/\b(part[- ]?time|parttime|teilzeit)\b/.test(h)) return 'part_time'
  if (/\b(temporary|temp|seasonal)\b/.test(h)) return 'temporary'
  if (/\b(full[- ]?time|fulltime|permanent|vollzeit|regular)\b/.test(h)) return 'full_time'
  if (/\b(this is a contract (role|position)|contract position|contract role|c2c|corp[- ]to[- ]corp|w2 contract|1099 contract)\b/.test(both)) return 'contract'
  if (/\bpart[- ]time (role|position)\b/.test(body)) return 'part_time'
  return h ? null : 'full_time'
}

export function contractTypeOf(text: string): ContractType | null {
  const t = fold(text.slice(0, 6000))
  if (/\b(c2c|corp[- ]to[- ]corp|corp 2 corp)\b/.test(t)) return 'c2c'
  if (/\b1099\b/.test(t)) return '1099'
  if (/\bw-?2\b/.test(t) && /\b(contract|hourly|rate)\b/.test(t)) return 'w2'
  return null
}

const STAFFING = /\b(staffing|recruit(ing|ment)|talent (solutions|partners|acquisition group)|search (group|partners)|personnel|placement|consultancy services|it solutions|infotech|technologies pvt)\b/i

export function isStaffingAgency(company: string, text = ''): boolean {
  return STAFFING.test(company) || /\b(on behalf of (our|a) client|our client is (seeking|looking)|our client, a)\b/i.test(text.slice(0, 3000))
}

/** Company name comparison key: folded, legal suffixes removed. */
export function companyKey(name: string): string {
  return fold(name)
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|incorporated|llc|l l c|ltd|limited|gmbh|corp|corporation|co|company|plc|s ?a|ag|bv|b v|pvt|private|pte|pty|oy|ab|as|srl|sas|sarl|kk|holdings?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
