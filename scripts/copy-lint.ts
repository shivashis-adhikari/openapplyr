// Checks interface copy against docs/design/design-language.md §13.
// 1. Every string literal in src/renderer/strings/en.ts: banned words, exclamation marks, emoji,
//    em dashes, flavor ellipses, Title Case.
// 2. Text written directly in components (JSX text and string props like label= or placeholder=),
//    which belongs in the strings module.
// 3. The website's visible text: banned words, exclamation marks, emoji, em dashes.
// Usage: node scripts/copy-lint.ts   (exit code 1 on any finding)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BANNED = [
  /\bseamless(ly)?\b/i,
  /\beffortless(ly)?\b/i,
  /\bunlock\b(?! openapplyr)/i,
  /\bsupercharge/i,
  /\belevate/i,
  /\bempower/i,
  /\brevolutioni[sz]e/i,
  /\bgame[- ]changer/i,
  /\bcutting[- ]edge/i,
  /\bnext[- ]level/i,
  /\bharness/i,
  /\bleverage/i,
  /\bdelve/i,
  /\brobust/i,
  /\bmagic(al)?\b/i,
  /\bjourney\b/i,
  /\bdream job/i,
  /\bsmart (match|apply|search|feature)/i,
  /\bai[- ]powered\b/i,
  /\bpowered by ai\b/i,
  /\b(oops|whoops)\b/i,
  /\bwelcome back\b/i,
  /\blet's\b/i,
  /^get started$/i,
  /\bsomething went wrong\b/i,
  /\bsuccessfully\b/i,
]
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{1F000}-\u{1F2FF}]/u
// Words that are always capitalized, so a label made of them is not Title Case.
const PROPER = new Set([
  'OpenApplyr', 'Google', 'Chrome', 'Microsoft', 'Edge', 'Chromium', 'Gmail', 'Outlook', 'Yahoo', 'iCloud', 'Fastmail', 'Proton', 'Bridge', 'LinkedIn', 'GitHub',
  'Word', 'PDF', 'CSV', 'JSON', 'IMAP', 'SMTP', 'TLS', 'USD', 'AM', 'PM', 'US', 'UK', 'EU', 'A4', 'Letter', 'Teal', 'Huntr', 'Ollama', 'LM', 'Studio', 'IBM', 'Plex',
  'Libre', 'Baskerville', 'SIL', 'Open', 'Font', 'License', 'GeoNames', 'CC', 'BY', 'GNU', 'AGPL', 'DELETE', 'Ctrl', 'J', 'K', 'Anthropic', 'OpenAI', 'Apache',
  'United', 'States', 'Kingdom', 'Canada', 'Europe', 'India', 'Australia', 'Elsewhere', 'Lisbon', 'Portugal',
])

const findings: string[] = []

function checkText(where: string, text: string): void {
  const t = text.trim()
  if (!t) return
  for (const re of BANNED) if (re.test(t)) findings.push(`${where}: banned phrase ${re} in "${t}"`)
  if (/!/.test(t) && !/!=|!\w/.test(t)) findings.push(`${where}: exclamation mark in "${t}"`)
  if (EMOJI.test(t)) findings.push(`${where}: emoji in "${t}"`)
  if (/—/.test(t)) findings.push(`${where}: em dash in "${t}"`)
  if (/\.\.\.|…/.test(t) && !/^https?:/.test(t)) findings.push(`${where}: ellipsis in "${t}"`)
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
  if (words.length >= 2 && words.length <= 6) {
    const caps = words.slice(1).filter((w) => w.length > 3 && /^[A-Z][a-z]/.test(w) && !PROPER.has(w.replace(/[^A-Za-z]/g, '')))
    if (caps.length >= 2) findings.push(`${where}: Title Case in "${t}"`)
  }
}

// 1. The strings module: every quoted or template string literal.
const stringsFile = 'src/renderer/strings/en.ts'
const src = readFileSync(stringsFile, 'utf8')
const lines = src.split('\n')
lines.forEach((line, i) => {
  // "// copy-ok: reason" marks a deliberate exception (design language §13).
  if (/^\s*\/\//.test(line) || /\/\/ copy-ok:/.test(line)) return
  for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const text = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, 'X')
    // Keys of lookup tables and short identifiers are not copy.
    if (/^[a-z_][a-z0-9_]*$/.test(text) || text.length < 2) continue
    checkText(`${stringsFile}:${i + 1}`, text)
  }
})

// 2. Components: visible text that bypasses the strings module.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []
  })
// Allowed inline: placeholders that are example values in any language, and punctuation.
const ALLOWED_INLINE = new Set(['https://', 'km', '2021-03', '2024-06', '08:00', '21:00', '1 month', 'Lisbon, Portugal', 'US Letter', 'A4', '*', '·', '–', '/5'])
for (const file of walk('src/renderer')) {
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|import )/.test(line)) return
    // JSX text before a closing tag (>Some words</x>), or a line that is only words inside JSX.
    const jsxText = [...line.matchAll(/>([^<>{}=&|?;()]*[A-Za-z][^<>{}=&|?;()]*)<\//g)].map((m) => m[1]!.trim())
    if (/^\s+[A-Z][a-z]+( [a-z]+)+\s*$/.test(line)) jsxText.push(line.trim())
    // Words between two expressions ({n} roles, {m} skills), skipping keywords like "} else {".
    for (const m of line.matchAll(/\}\s*([a-z][a-z ,]*[a-z])\s*,?\s*\{/g)) {
      if (!/^(else|finally|catch|while)$/.test(m[1]!)) findings.push(`${file}:${i + 1}: inline text "${m[1]}" belongs in ${stringsFile}`)
    }
    for (const s of jsxText) {
      if (s && !ALLOWED_INLINE.has(s) && !/^[\w.]+$/.test(s)) findings.push(`${file}:${i + 1}: inline text "${s}" belongs in ${stringsFile}`)
    }
    // Visible string props.
    for (const m of line.matchAll(/\b(label|placeholder|title|help|aria-label|ariaLabel)="([^"]*[A-Za-z][^"]*)"/g)) {
      if (!ALLOWED_INLINE.has(m[2]!)) findings.push(`${file}:${i + 1}: inline ${m[1]}="${m[2]}" belongs in ${stringsFile}`)
    }
  })
}

// 3. The website: every visible sentence follows the same rules.
const site = readFileSync('site/index.html', 'utf8')
  .replace(/<svg[\s\S]*?<\/svg>|<script[\s\S]*?<\/script>|<pre[\s\S]*?<\/pre>/g, ' ')
  .replace(/&[a-z]+;/g, ' ')
for (const text of site.split(/<[^>]+>/)) {
  const t = text.trim()
  if (!t) continue
  for (const re of BANNED) if (re.test(t)) findings.push(`site/index.html: banned phrase ${re} in "${t}"`)
  if (/!/.test(t)) findings.push(`site/index.html: exclamation mark in "${t}"`)
  if (EMOJI.test(t)) findings.push(`site/index.html: emoji in "${t}"`)
  if (/—/.test(t)) findings.push(`site/index.html: em dash in "${t}"`)
}

if (findings.length) {
  console.error(findings.join('\n'))
  console.error(`\n${findings.length} copy problem${findings.length === 1 ? '' : 's'}. Rules: docs/design/design-language.md §13.`)
  process.exit(1)
}
console.log('Copy check passed.')
