import DOMPurify from 'dompurify'
import { useMemo } from 'react'
import { bridge } from '../lib/bridge'

const ALLOWED = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div', 'span']

/** Minimal Markdown for postings that came as text: headings, lists, paragraphs. */
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  const out: string[] = []
  let list = false
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    const item = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (item) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${inline(item[1]!)}</li>`)
      continue
    }
    if (list) {
      out.push('</ul>')
      list = false
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) out.push(`<h3>${inline(h[2]!)}</h3>`)
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('')
}

/**
 * Posting text from a third party: sanitized to plain structure (no scripts, styles, images or forms),
 * with links opening in the user's browser.
 */
export function Posting({ html, md }: { html: string | null; md: string }) {
  const clean = useMemo(
    () => DOMPurify.sanitize(html && html.trim() ? html : mdToHtml(md), { ALLOWED_TAGS: ALLOWED, ALLOWED_ATTR: ['href'], ALLOW_DATA_ATTR: false }),
    [html, md],
  )
  return (
    <div
      className="prose"
      // Sanitized above with an allowlist of structural tags.
      dangerouslySetInnerHTML={{ __html: clean }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const url = a.getAttribute('href')
        if (url && /^https?:\/\//.test(url)) void bridge.host.openExternal(url)
      }}
    />
  )
}
