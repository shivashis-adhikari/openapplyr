// Colors in the interface come only from src/renderer/styles/tokens.css (design language §3).
// Flags hex values and rgb()/hsl() literals anywhere else in the renderer.
// Usage: node scripts/hex-lint.ts   (exit code 1 on any finding)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = join('src', 'renderer', 'styles', 'tokens.css')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(p) ? [p] : []
  })

const findings: string[] = []
for (const file of walk(join('src', 'renderer'))) {
  if (file === TOKENS) continue
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // Ignore URL fragments and routes such as "#/jobs".
      const code = line.replace(/['"`]#\/[^'"`]*['"`]/g, '')
      for (const m of code.matchAll(/(?<![\w&/])#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/g)) findings.push(`${file}:${i + 1}: raw color "${m[0]}"; use a token from ${TOKENS}`)
    })
}
if (findings.length) {
  console.error(findings.join('\n'))
  process.exit(1)
}
console.log('Color check passed.')
