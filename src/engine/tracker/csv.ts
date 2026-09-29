import type { AppStatus } from '../../shared/domain'
import type { Db } from '../core/db'
import { companyKey, titleKey } from '../jobs/classify'
import { csvObjects, toCsv } from '../util/csv'
import { addEvent, createApplication } from './applications'

export const IMPORT_FIELDS = ['company', 'title', 'status', 'appliedAt', 'url', 'location', 'notes'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
export type Mapping = Partial<Record<ImportField, string>>

// Header names used by Teal, Huntr, Simplify and plain spreadsheets.
const HEADER_HINTS: Record<ImportField, RegExp> = {
  company: /^(company( name)?|employer|organi[sz]ation)$/i,
  title: /^(job )?(title|position|role)( title)?$|^job$/i,
  status: /^(status|stage|list|column|pipeline stage)$/i,
  appliedAt: /^(date )?applied( on| date| at)?$|^application date$|^date$/i,
  url: /^(job )?(url|link|posting( url| link)?)$/i,
  location: /^(job )?location$/i,
  notes: /^notes?$|^comments?$/i,
}

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {}
  for (const f of IMPORT_FIELDS) {
    const h = headers.find((x) => HEADER_HINTS[f].test(x.trim()))
    if (h) m[f] = h
  }
  return m
}

/** Status words from other trackers. "skip" rows were saved but never applied to. */
export function mapStatus(text: string): AppStatus | 'skip' {
  const t = text.trim().toLowerCase()
  if (!t) return 'applied'
  if (/wish|saved|bookmark|interested|to apply|not applied|draft/.test(t)) return 'skip'
  if (/offer/.test(t)) return /accept/.test(t) ? 'accepted' : /declin/.test(t) ? 'declined' : 'offer'
  if (/accept/.test(t)) return 'accepted'
  if (/reject|not selected|declined by|unsuccessful/.test(t)) return 'rejected'
  if (/withdr/.test(t)) return 'withdrawn'
  if (/ghost|no response/.test(t)) return 'ghosted'
  if (/interview|onsite|final|technical/.test(t)) return 'interviewing'
  if (/screen|phone|recruiter call/.test(t)) return 'screening'
  return 'applied'
}

/** ISO dates, "Sep 3, 2026", and slash dates (month first for US and Canada, day first elsewhere). */
export function parseDate(text: string, monthFirst: boolean): number | null {
  const t = text.trim()
  if (!t) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(t)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    const year = Number(m[3]!.length === 2 ? `20${m[3]}` : m[3])
    const [month, day] = a > 12 ? [b, a] : b > 12 ? [a, b] : monthFirst ? [a, b] : [b, a]
    return new Date(year, month - 1, day, 12).getTime()
  }
  const parsed = Date.parse(t)
  return Number.isNaN(parsed) ? null : parsed
}

export type ImportPreview = { headers: string[]; sample: Record<string, string>[]; mapping: Mapping; rows: number }

export function previewImport(text: string): ImportPreview {
  const rows = csvObjects(text)
  const headers = Object.keys(rows[0] ?? {})
  return { headers, sample: rows.slice(0, 5), mapping: guessMapping(headers), rows: rows.length }
}

export type ImportResult = { imported: number; skipped: number; duplicates: number; errors: string[] }

export function importApplications(db: Db, text: string, mapping: Mapping, now: number, monthFirst: boolean): ImportResult {
  const out: ImportResult = { imported: 0, skipped: 0, duplicates: 0, errors: [] }
  const rows = csvObjects(text)
  const get = (r: Record<string, string>, f: ImportField) => (mapping[f] ? (r[mapping[f]!] ?? '').trim() : '')
  db.tx(() => {
    for (const [i, r] of rows.entries()) {
      const company = get(r, 'company')
      const title = get(r, 'title')
      if (!company || !title) {
        out.errors.push(`Row ${i + 2}: company and title are required.`)
        continue
      }
      const status = mapStatus(get(r, 'status'))
      if (status === 'skip') {
        out.skipped++
        continue
      }
      const groupKey = `manual:${companyKey(company)}:${titleKey(title)}`
      if (db.get('SELECT 1 FROM applications WHERE group_key = ? AND archived = 0', [groupKey])) {
        out.duplicates++
        continue
      }
      const appliedAt = parseDate(get(r, 'appliedAt'), monthFirst) ?? now
      const url = get(r, 'url')
      const id = createApplication(
        db,
        { jobId: null, groupKey, companyId: null, company, title, huntId: null, packageId: null, status, channel: 'other', url: /^https?:\/\//.test(url) ? url : null, appliedAt, source: 'import' },
        appliedAt,
      )
      const notes = [get(r, 'notes'), get(r, 'location') ? `Location: ${get(r, 'location')}` : ''].filter(Boolean).join('\n')
      db.run('UPDATE applications SET notes = ?, method = ? WHERE id = ?', [notes, 'manual', id])
      if (status !== 'applied') addEvent(db, id, 'status', 'import', { from: 'applied', to: status }, appliedAt)
      out.imported++
    }
  })
  return out
}

export function exportApplications(db: Db, format: 'csv' | 'json'): string {
  const rows = db.all<Record<string, string | number | null>>(
    `SELECT a.id, a.company_name company, a.title, a.status, a.channel, a.method, a.url, a.applied_at, a.last_activity_at, h.name hunt, a.notes, a.archived
     FROM applications a LEFT JOIN hunts h ON h.id = a.hunt_id ORDER BY a.created_at`,
  )
  const iso = (v: string | number | null) => (typeof v === 'number' ? new Date(v).toISOString() : '')
  const clean = rows.map((r) => ({ ...r, applied_at: iso(r['applied_at'] ?? null), last_activity_at: iso(r['last_activity_at'] ?? null), archived: r['archived'] ? 'yes' : 'no' }))
  if (format === 'json') return JSON.stringify(clean, null, 2)
  const headers = ['id', 'company', 'title', 'status', 'channel', 'method', 'url', 'applied_at', 'last_activity_at', 'hunt', 'notes', 'archived']
  return toCsv([headers, ...clean.map((r) => headers.map((h) => (r as Record<string, string | number | null>)[h] ?? ''))])
}
