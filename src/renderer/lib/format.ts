const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** "14 minutes ago", "3 hours ago", "Yesterday", "Sep 12". Exact where it matters, short otherwise. */
export function ago(t: number | null | undefined, now = Date.now()): string {
  if (!t) return ''
  const d = now - t
  if (d < 0) return until(t, now)
  if (d < MIN) return 'Just now'
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute ago', 'minutes ago')
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour ago', 'hours ago')
  if (d < 2 * DAY) return 'Yesterday'
  if (d < 7 * DAY) return plural(Math.floor(d / DAY), 'day ago', 'days ago')
  return date(t)
}

export function until(t: number, now = Date.now()): string {
  const d = t - now
  if (d < HOUR) return `in ${plural(Math.max(1, Math.round(d / MIN)), 'minute', 'minutes')}`
  if (d < DAY) return `in ${plural(Math.round(d / HOUR), 'hour', 'hours')}`
  return `in ${plural(Math.round(d / DAY), 'day', 'days')}`
}

export const date = (t: number | null | undefined, withYear = false) =>
  t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear || new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }) : ''

export const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
export const dateTime = (t: number) => `${new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time(t)}`

export function money(amount: number | null | undefined, currency: string | null | undefined, compact = true): string {
  if (amount === null || amount === undefined) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0, ...(compact && amount >= 10_000 ? { notation: 'compact' } : {}) }).format(amount)
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency ?? ''}`.trim()
  }
}

/** AI spend: "$0.04", "about $1.20" when estimated. */
export const dollars = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

export const pct = (n: number) => `${Math.round(n * 100)}%`

/** "€80k–98k a year", or the posting's own words when the numbers are missing. */
export function salary(s: { min: number | null; max: number | null; currency: string | null; period: string | null; text: string } | null): string {
  if (!s) return ''
  if (s.min === null && s.max === null) return s.text
  const per = s.period === 'hour' ? ' an hour' : s.period === 'month' ? ' a month' : ' a year'
  const lo = s.min !== null ? money(s.min, s.currency) : ''
  const hi = s.max !== null ? money(s.max, s.currency) : ''
  return `${lo && hi && lo !== hi ? `${lo} to ${hi}` : lo || hi}${per}`
}
