import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResumeContent, TemplateInfo } from '../../src/shared/domain'

export type TemplateExtras = { noticePeriod?: string; workAuthorization?: string; region?: string }
export type TemplateContext = { content: ResumeContent; pageSize: 'Letter' | 'A4'; fontsDir: string; extras: TemplateExtras }
export type ResumeTemplate = TemplateInfo & { render(ctx: TemplateContext): string }

export const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtDate(d: string | null, o: { present?: string; numeric?: boolean } = {}): string {
  if (d === null) return o.present ?? 'Present'
  const [y, m] = d.split('-')
  if (!y) return ''
  if (!m) return y
  return o.numeric ? `${m}/${y}` : `${MONTHS[Number(m) - 1] ?? m} ${y}`
}

export function dateRange(start: string, end: string | null, o: { present?: string; numeric?: boolean } = {}): string {
  const a = fmtDate(start, o)
  const b = fmtDate(end, o)
  return a ? `${a} – ${b}` : b
}

export const displayUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'

const cache = new Map<string, string>()

/** @font-face rules with the font files inlined, so the PDF looks the same on every machine. */
export function fontFaces(fontsDir: string, faces: { family: string; file: string; weight: number; style?: 'normal' | 'italic' }[]): string {
  return faces
    .flatMap((f) =>
      (['latin', 'latin-ext'] as const).map((subset) => {
        const name = `${f.file}-${subset}-${f.weight}-${f.style ?? 'normal'}.woff2`
        let b64 = cache.get(name)
        if (b64 === undefined) {
          try {
            b64 = readFileSync(join(fontsDir, name)).toString('base64')
          } catch {
            b64 = ''
          }
          cache.set(name, b64)
        }
        if (!b64) return ''
        return `@font-face{font-family:'${f.family}';font-style:${f.style ?? 'normal'};font-weight:${f.weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${subset === 'latin' ? LATIN : LATIN_EXT};}`
      }),
    )
    .join('\n')
}

export function page(ctx: TemplateContext, css: string, body: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${esc(title)}</title>
<style>
@page { size: ${ctx.pageSize}; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-kerning: normal; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
ul { list-style: none; }
li { break-inside: avoid; }
a { color: inherit; text-decoration: none; }
.entry { break-inside: avoid-page; }
${css}
</style></head><body>${body}</body></html>`
}

export function contactItems(c: ResumeContent): string[] {
  return [c.contact.location, c.contact.email, c.contact.phone, ...c.contact.links.map((l) => displayUrl(l.url))].filter(Boolean).map(esc)
}

export const bullets = (lines: { text: string }[], cls = 'b') => (lines.length ? `<ul class="${cls}">${lines.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul>` : '')

export function join2(a: string, b: string, sep = ', '): string {
  return [a, b].filter(Boolean).join(sep)
}

