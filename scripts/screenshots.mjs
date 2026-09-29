// Launches the built app on the fictional sample workspace and captures every screen.
// Usage: npm run build && node scripts/screenshots.mjs [outDir] [--dark]
// Used for design review and for the website's images. Nothing here touches a real site.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'screenshots'
const dark = process.argv.includes('--dark')
mkdirSync(out, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'openapplyr-shots-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, OPENAPPLYR_DATA_DIR: dataDir, OPENAPPLYR_DEMO: '1' } })
const errors = []
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  // Wait for the sample workspace to be seeded and the shell to render.
  await win.waitForSelector('.shell', { timeout: 120_000 })
  // A fixed 1440x900 viewport at 2x, whatever the display, so every capture has the same framing.
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await win.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  const shots = [
    ['today', '#/today'],
    ['jobs', '#/jobs?view=matches'],
    ['queue', '#/queue'],
    ['applications', '#/applications?view=board'],
    ['application', '#/applications?view=board&app=6'],
    ['results', '#/applications?view=results'],
    ['outreach', '#/outreach?tab=drafts'],
    ['inbox', '#/inbox?filter=all'],
    ['documents', '#/documents?tab=profile'],
    ['resumes', '#/documents?tab=resumes'],
    ['prep', '#/prep?tab=interviews'],
    ['hunts', '#/hunts'],
    ['activity', '#/activity?tab=runs'],
    ['settings', '#/settings?tab=models'],
  ]
  for (const [name, hash] of shots) {
    await win.evaluate((h) => (window.location.hash = h), hash)
    await win.waitForTimeout(900)
    await win.screenshot({ path: join(out, `${name}${dark ? '-dark' : ''}.png`) })
  }
} finally {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (errors.length) console.log(errors.join('\n'))
}
