// Launches the built app with a throwaway data folder and checks that the UI reaches the engine.
// Usage: npm run build && node scripts/smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const dataDir = mkdtempSync(join(tmpdir(), 'openapplyr-smoke-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, OPENAPPLYR_DATA_DIR: dataDir, OPENAPPLYR_HIDDEN: '1' } })
const logs = []
app.process().stderr?.on('data', (d) => logs.push(String(d)))
try {
  const win = await app.firstWindow()
  win.on('console', (m) => logs.push(`console.${m.type()}: ${m.text()}\n`))
  win.on('pageerror', (e) => logs.push(`pageerror: ${e.message}\n`))
  const status = await win.evaluate(() => window.openapplyr.call('app.status', undefined))
  const csp = await win.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'))
  const hasNode = await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined')
  console.log(JSON.stringify({ url: win.url(), status, csp, hasNode }, null, 2))
  if (hasNode) throw new Error('Renderer can reach Node APIs')
  if (!csp?.includes("script-src 'self'")) throw new Error('CSP missing')
} finally {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (logs.length) console.log(logs.join('').slice(0, 4000))
}
