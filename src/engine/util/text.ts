import { randomUUID } from 'node:crypto'

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`

/** Lowercase, strip accents and punctuation, collapse whitespace. For comparisons, never for display. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9+#.%$€£₹'\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function words(s: string): string[] {
  return fold(s)
    .split(/[\s/]+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(Boolean)
}

/** Share of `a`'s words that appear in `b` (0..1). */
export function coverage(a: string, b: string | Set<string>): number {
  const wa = words(a)
  if (wa.length === 0) return 1
  const set = typeof b === 'string' ? new Set(words(b)) : b
  return wa.filter((w) => set.has(w)).length / wa.length
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
}

export function isPresent(s: string | null | undefined): boolean {
  return !s || /^(present|current|now|today|ongoing|actual|heute|aujourd'hui)$/i.test(s.trim())
}

/** "Jan 2020", "01/2020", "2020-01-15", "2020" -> "2020-01" / "2020". Unparseable input returns ''. */
export function normalizeMonth(input: string | null | undefined): string {
  const s = (input ?? '').trim().toLowerCase()
  if (!s) return ''
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(s)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s)
  if (m && Number(m[1]) <= 12) return `${m[2]}-${m[1]!.padStart(2, '0')}`
  m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/.exec(s)
  if (m && MONTHS[m[1]!.slice(0, m[1]!.startsWith('sept') ? 4 : 3)]) return `${m[2]}-${MONTHS[m[1]!.slice(0, m[1]!.startsWith('sept') ? 4 : 3)]}`
  m = /^(\d{4})$/.exec(s)
  if (m) return m[1]!
  return ''
}

/** Months between two YYYY or YYYY-MM dates; end null means now. */
export function monthsBetween(start: string, end: string | null, now = new Date()): number {
  const parse = (s: string) => {
    const [y, mo] = s.split('-')
    return Number(y) * 12 + (mo ? Number(mo) - 1 : 0)
  }
  if (!start) return 0
  const e = end ? parse(end) : now.getFullYear() * 12 + now.getMonth()
  return Math.max(0, e - parse(start) + 1)
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
