/** RFC 4180 CSV: quoted fields, doubled quotes, embedded newlines, CRLF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

/** Rows as objects keyed by the header row. LinkedIn exports sometimes prepend notes; skip until a header matches. */
export function csvObjects(text: string, requiredHeader?: string): Record<string, string>[] {
  const rows = parseCsv(text)
  let h = 0
  if (requiredHeader) {
    h = rows.findIndex((r) => r.some((c) => c.trim() === requiredHeader))
    if (h < 0) return []
  }
  const header = (rows[h] ?? []).map((c) => c.trim())
  return rows.slice(h + 1).map((r) => Object.fromEntries(header.map((k, i) => [k, (r[i] ?? '').trim()])))
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v)
    // Neutralize spreadsheet formula injection for values that begin with = + - @.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}
