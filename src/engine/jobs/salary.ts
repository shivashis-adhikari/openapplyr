import type { Salary } from '../../shared/domain'

type Period = NonNullable<Salary['period']>

const SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', 'R$': 'BRL', 'C$': 'CAD', 'A$': 'AUD', 'S$': 'SGD', 'NZ$': 'NZD', 'HK$': 'HKD', CHF: 'CHF', zł: 'PLN', kr: 'SEK' }
const CODES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'SGD', 'NZD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'ZAR', 'AED', 'HKD', 'ILS', 'CZK', 'HUF', 'RON', 'TRY', 'KRW', 'PHP', 'NGN', 'KES']

/** Hours per year for converting hourly pay; months per year for monthly pay. */
export const ANNUAL_FACTOR: Record<Period, number> = { year: 1, month: 12, hour: 2080 }

function toNumber(raw: string, currency: string | null): number | null {
  let s = raw.trim().toLowerCase().replace(/\s/g, '')
  let mult = 1
  const suffix = /(k|m|lakhs?|lacs?|l|lpa|cr|crores?)$/.exec(s)
  if (suffix) {
    s = s.slice(0, -suffix[0].length)
    const x = suffix[0]
    mult = x === 'k' ? 1e3 : x === 'm' ? 1e6 : /^(l|lakh|lakhs|lac|lacs|lpa)$/.test(x) ? 1e5 : 1e7
  }
  // "60.000" (dot thousands) vs "60.5k" (decimal); "12,00,000" (Indian grouping) vs "120,000".
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  const v = n * mult
  void currency
  return v
}

function detectPeriod(text: string): Period | null {
  if (/\b(per\s+hour|an\s+hour|hourly|\/\s*h(ou)?r|p\/h|ph\b)/i.test(text)) return 'hour'
  if (/\b(per\s+month|a\s+month|monthly|\/\s*mo(nth)?|pcm)\b/i.test(text)) return 'month'
  if (/\b(per\s+(year|annum)|a\s+year|annual(ly)?|yearly|\/\s*y(ea)?r|p\.?a\.?|lpa|ctc|salary)\b/i.test(text)) return 'year'
  return null
}

function detectCurrency(text: string): string | null {
  const code = new RegExp(`\\b(${CODES.join('|')})\\b`, 'i').exec(text)
  if (code) return code[1]!.toUpperCase()
  for (const sym of ['NZ$', 'HK$', 'R$', 'C$', 'A$', 'S$']) if (text.includes(sym)) return SYMBOL[sym]!
  if (/\b(lpa|lakhs?|lacs?|crores?|ctc)\b/i.test(text) || text.includes('₹')) return 'INR'
  for (const sym of ['€', '£', '¥', '₩', '₽', '₺', '$']) if (text.includes(sym)) return SYMBOL[sym]!
  return null
}

const NUM = String.raw`(?:\d{1,3}(?:[,.]\d{2,3})+|\d+(?:\.\d+)?)\s*(?:k|m|lakhs?|lacs?|lpa|l|cr|crores?)?`
// Explicit currency codes: a generic [A-Z]{3} under the i flag matches words like "ith" in "with 4%".
const CODE_ALT = `(?:${CODES.join('|')})`
const CUR = `(?:${CODE_ALT}\\s?|NZ\\$|HK\\$|R\\$|C\\$|A\\$|S\\$|[$€£₹¥])?`
const RANGE_RE = new RegExp(`(${CUR})\\s*(${NUM})\\s*(?:[-–—]|to|and)\\s*(${CUR})\\s*(${NUM})`, 'gi')
const SINGLE_RE = new RegExp(`(up to|from|starting at|minimum of|min\\.?|max\\.?)?\\s*(${CODE_ALT}\\s?|NZ\\$|HK\\$|R\\$|C\\$|A\\$|S\\$|[$€£₹¥])\\s*(${NUM})`, 'gi')
const PAY_WORDS = /(salary|compensation|pay|base|range|ctc|lpa|wage|rate|per (hour|year|annum|month)|hourly|annual|\/hr|\/yr|k\b|OTE)/i

function plausible(annual: number, currency: string | null): boolean {
  if (currency === 'INR') return annual >= 100_000 && annual <= 200_000_000
  if (currency === 'JPY' || currency === 'KRW') return annual >= 1_000_000 && annual <= 500_000_000
  return annual >= 8_000 && annual <= 2_500_000
}

/**
 * Extracts a pay range from free text. Returns null when nothing clearly salary-like is present,
 * so funding amounts, 401(k) mentions and headcounts are not mistaken for pay.
 */
export function parseSalary(text: string | null | undefined): Salary | null {
  if (!text) return null
  const t = text.replace(/ /g, ' ')
  const candidates: { min: number; max: number | null; currency: string | null; period: Period | null; text: string; index: number }[] = []
  for (const m of t.matchAll(RANGE_RE)) {
    const ctx = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40)
    const currency = detectCurrency(`${m[1]} ${m[3]} ${ctx}`)
    const lowRaw = m[2]!
    const highRaw = m[4]!
    // "120-150k": the suffix on the high value applies to both.
    const suffix = /(k|m|lpa|l|lakhs?|lacs?)$/i.exec(highRaw.trim())?.[0] ?? ''
    const low = toNumber(/[a-z]$/i.test(lowRaw.trim()) || !suffix ? lowRaw : `${lowRaw}${suffix}`, currency)
    const high = toNumber(highRaw, currency)
    if (low === null || high === null || high < low) continue
    if (!currency && !PAY_WORDS.test(ctx)) continue
    candidates.push({ min: low, max: high, currency, period: detectPeriod(ctx), text: m[0].trim(), index: m.index })
  }
  if (candidates.length === 0) {
    for (const m of t.matchAll(SINGLE_RE)) {
      const ctx = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40)
      if (!PAY_WORDS.test(ctx)) continue
      const currency = detectCurrency(`${m[2]} ${ctx}`)
      const v = toNumber(m[3]!, currency)
      if (v === null) continue
      const upTo = /up to|max/i.test(m[1] ?? '')
      candidates.push({ min: upTo ? 0 : v, max: upTo ? v : null, currency, period: detectPeriod(ctx), text: m[0].trim(), index: m.index })
    }
  }
  for (const c of candidates) {
    let period = c.period
    const top = c.max ?? c.min
    if (!period) period = top < 500 ? 'hour' : top < 25_000 && c.currency !== 'INR' ? 'month' : 'year'
    const annualTop = top * ANNUAL_FACTOR[period]
    if (!plausible(annualTop, c.currency)) continue
    return { min: c.min || null, max: c.max, currency: c.currency, period, text: c.text }
  }
  return null
}

export function annualize(s: Salary | null): { min: number | null; max: number | null } {
  if (!s || !s.period) return { min: null, max: null }
  const f = ANNUAL_FACTOR[s.period]
  return { min: s.min != null ? s.min * f : null, max: s.max != null ? s.max * f : null }
}

export function formatSalary(s: Salary | null): string {
  if (!s) return ''
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: s.currency ?? 'USD', notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 1 : 0 }).format(n)
    } catch {
      return String(n)
    }
  }
  const per = s.period === 'hour' ? '/hr' : s.period === 'month' ? '/mo' : '/yr'
  if (s.min && s.max) return `${fmt(s.min)}–${fmt(s.max)}${per}`
  if (s.max) return `up to ${fmt(s.max)}${per}`
  if (s.min) return `from ${fmt(s.min)}${per}`
  return s.text
}
