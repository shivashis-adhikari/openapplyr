const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', times: '×',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return NAMED[code.toLowerCase()] ?? whole
  })
}

/**
 * Job descriptions arrive as HTML (sometimes entity-escaped HTML). Converts to readable Markdown for
 * prompts and search: headings, paragraphs, lists, bold, links. Scripts and styles are dropped.
 */
export function htmlToMarkdown(input: string): string {
  let html = input
  // Greenhouse returns escaped HTML ("&lt;p&gt;").
  if (!/<[a-z!/]/i.test(html) && /&lt;[a-z/]/i.test(html)) html = decodeEntities(html)
  html = html
    .replace(/<(script|style|noscript|iframe|svg|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => `\n\n${'#'.repeat(Math.min(Number(level) + 1, 4))} ${strip(text)}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, _a, text: string) => {
      const t = strip(text)
      return t ? `**${t}**` : ''
    })
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = strip(text)
      return /^https?:/i.test(href) && t && t !== href ? `[${t}](${href})` : t || href
    })
    .replace(/<\/(p|div|section|article|header|footer|table|tr)>/gi, '\n\n')
    .replace(/<(p|div|section|article|tr)(\s[^>]*)?>/gi, '\n\n')
    .replace(/<\/?(td|th)[^>]*>/gi, ' ')
  const text = decodeEntities(html.replace(/<[^>]+>/g, ''))
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n- \s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function strip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export function htmlToText(input: string): string {
  return htmlToMarkdown(input)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
}
