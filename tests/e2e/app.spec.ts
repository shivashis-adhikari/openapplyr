import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import { t } from '../../src/renderer/strings/en'
import { launch } from './launch'
import { unreachable } from './layout'

const RESUME = `Daniel Brandt
daniel.brandt@example.com | Berlin, Germany

Experience
Platform Engineer, Kiefer Logistics, Berlin | 2021-03 to present
- Moved 40 services to Kubernetes and cut deploy time from 30 to 6 minutes.
Software Engineer, Nordlicht Media, Hamburg | 2018-01 to 2021-02
- Built the video upload pipeline in Go.

Skills
Go, Kubernetes, Terraform, PostgreSQL

Education
BSc Computer Science, TU Hamburg, 2017`

test('first run: model, resume, facts, hunt, then the first search', async () => {
  const { win, api, close } = await launch()
  try {
    // The sample workspace is already set up; ask for the first-run screens again.
    await api('settings.update', { onboarded: false })
    await win.reload()
    await expect(win.getByRole('heading', { name: t.onboarding.modelTitle })).toBeVisible()
    await win.getByRole('button', { name: t.onboarding.next }).click()

    await expect(win.getByRole('heading', { name: t.onboarding.profileTitle })).toBeVisible()
    await win.getByRole('button', { name: t.profile.paste }).click()
    const dialog = win.getByRole('dialog')
    await dialog.getByLabel(t.profile.pasteLabel).fill(RESUME)
    await dialog.getByRole('button', { name: t.onboarding.next }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(win.getByText('Daniel Brandt')).toBeVisible()
    await win.getByRole('button', { name: t.onboarding.next }).click()

    await expect(win.getByRole('heading', { name: t.onboarding.factsTitle })).toBeVisible()
    await win.getByRole('button', { name: t.onboarding.next }).click()

    await expect(win.getByRole('heading', { name: t.onboarding.huntTitle })).toBeVisible()
    await win.getByLabel(t.hunts.titles).fill('Platform Engineer')
    await win.getByLabel(t.hunts.places).fill('Munich, Germany')
    await win.getByRole('button', { name: t.onboarding.next }).click()

    await expect(win.getByRole('heading', { name: t.onboarding.emailTitle })).toBeVisible()
    await win.getByRole('button', { name: t.onboarding.finish }).click()
    await expect(win.getByRole('heading', { name: t.today.title })).toBeVisible()

    const profile = await api<{ profile: { basics: { name: string } } }>('profile.get')
    expect(profile.profile.basics.name).toBe('Daniel Brandt')
    const hunts = await api<{ hunt: { name: string; config: { places: { city: string | null; country: string | null; lat: number | null }[] } } }[]>('hunts.list')
    const hunt = hunts.find((h) => h.hunt.name === 'Platform Engineer')!.hunt
    // The place is looked up by name: coordinates for distance filters, and its own country.
    expect(hunt.config.places[0]).toMatchObject({ city: 'Munich', country: 'DE' })
    expect(hunt.config.places[0]!.lat).not.toBeNull()
  } finally {
    await close()
  }
})

test('the interface keeps working after the engine crashes', async () => {
  test.skip(process.platform === 'win32', 'finds the engine process with ps')
  const { app, win, api, close } = await launch()
  try {
    const main = app.process().pid!
    const engine = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, ppid, ...cmd]) => Number(ppid) === main && cmd.join(' ').includes('node.mojom.NodeService'))
    expect(engine).toBeDefined()
    process.kill(Number(engine![0]), 'SIGKILL')

    await expect.poll(() => api('app.status').then(() => true, () => false), { timeout: 30_000 }).toBe(true)
    await win.getByRole('link', { name: t.nav.jobs }).click()
    await expect(win.getByRole('heading', { name: t.jobs.title })).toBeVisible()
    await expect.poll(async () => (await api<{ total: number }>('jobs.list', { view: 'all' })).total).toBeGreaterThan(0)
  } finally {
    await close()
  }
})

test('every resume template renders to PDF and Word, and the PDF reads back in order', async () => {
  const { api, close } = await launch()
  try {
    const templates = await api<{ id: string; atsSafe: boolean }[]>('templates.list')
    expect(templates).toHaveLength(8)
    const [resume] = await api<{ id: number }[]>('resumes.list', { kind: 'tailored' })
    for (const tpl of templates) {
      await api('resumes.update', { id: resume!.id, templateId: tpl.id })
      const files = await api<{ pdfPath: string; docxPath: string }>('resumes.render', { id: resume!.id })
      expect(statSync(files.pdfPath).size, tpl.id).toBeGreaterThan(5_000)
      expect(statSync(files.docxPath).size, tpl.id).toBeGreaterThan(3_000)
      const ats = await api<{ text: string; checks: { ok: boolean; label: string; detail: string }[] }>('resumes.ats', { id: resume!.id })
      // What an applicant tracking system extracts: the name first and whole, readable headings and
      // contact details, and the experience in order.
      expect(ats.text.trim().split('\n')[0], tpl.id).toBe('Maya Okafor')
      expect(ats.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`), tpl.id).toEqual([])
      expect(ats.text.indexOf('Northwind Payments'), tpl.id).toBeLessThan(ats.text.indexOf('Tidewater Analytics'))
    }
  } finally {
    await close()
  }
})

const SCREENS = ['/today', '/jobs', '/queue', '/applications', '/outreach', '/inbox', '/documents', '/prep', '/hunts', '/activity', '/settings']
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

for (const scheme of ['light', 'dark'] as const) {
  test(`every screen passes axe checks (${scheme})`, async () => {
    const { win, close } = await launch()
    try {
      await win.emulateMedia({ colorScheme: scheme })
      // Evaluated through the debugger, so the page's content security policy does not apply.
      await win.evaluate(axeSource)
      const problems: string[] = []
      // A fixed desktop size and a narrow one (sidebar collapsed), whatever the machine's screen.
      const cdp = await win.context().newCDPSession(win)
      for (const [width, height] of [
        [1280, 800],
        [900, 640],
      ]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: width!, height: height!, deviceScaleFactor: 1, mobile: false })
        for (const path of SCREENS) {
          await win.evaluate((p) => ((globalThis as unknown as { location: { hash: string } }).location.hash = p), path)
          await win.waitForTimeout(600)
          const found = await win.evaluate(async () => {
            const axe = (globalThis as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe
            const r = await axe.run((globalThis as unknown as { document: unknown }).document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
            return r.violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`)
          })
          problems.push(...found.map((f) => `${width}px ${path} ${f}`))
        }
      }
      expect(problems).toEqual([])
    } finally {
      await close()
    }
  })
}

// Common screens: desktop, 1366x768 laptops, 1920x1080 at 150% and 1366x768 at 125% scaling, and the
// smallest window allowed (also what a 1280-wide window becomes at 160% zoom).
const SIZES = [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [1093, 614],
  [960, 600],
  [800, 560],
]
const VIEWS = ['#/today', '#/jobs?view=matches', '#/queue', '#/applications?view=board', '#/applications?view=board&app=6', '#/applications?view=table', '#/applications?view=results', '#/outreach?tab=drafts', '#/inbox?filter=all', '#/documents?tab=profile', '#/documents?tab=resumes', '#/prep?tab=interviews', '#/prep?tab=offers', '#/hunts', '#/activity?tab=runs', '#/settings?tab=models']

test('every screen fits at common sizes and scalings, with nothing cut off', async () => {
  test.setTimeout(180_000)
  const { win, close } = await launch()
  try {
    const cdp = await win.context().newCDPSession(win)
    const problems: string[] = []
    for (const [width, height] of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: width!, height: height!, deviceScaleFactor: 1, mobile: false })
      for (const view of VIEWS) {
        await win.evaluate((h) => ((globalThis as unknown as { location: { hash: string } }).location.hash = h), view)
        await win.waitForTimeout(300)
        problems.push(...(await unreachable(win)).map((p) => `${width}x${height} ${view}: ${p}`))
      }
    }
    expect(problems).toEqual([])
  } finally {
    await close()
  }
})
