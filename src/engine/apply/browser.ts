import { mkdirSync } from 'node:fs'
import { type BrowserContext, type Page, chromium } from 'playwright-core'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'

export type BrowserLauncher = () => Promise<BrowserContext>

/**
 * One persistent browser profile for applying (cookies and ATS sessions survive between runs).
 * Uses the installed Chrome or Edge; downloads are off and the site gets no extra permissions.
 */
export class BrowserManager {
  private context: BrowserContext | null = null
  private opening: Promise<BrowserContext> | null = null

  constructor(
    private readonly ctx: Ctx,
    private readonly launcher?: BrowserLauncher,
  ) {}

  private async launch(): Promise<BrowserContext> {
    if (this.launcher) return this.launcher()
    const a = this.ctx.settings.get().automation
    mkdirSync(this.ctx.paths.browserProfile, { recursive: true })
    const common = {
      headless: a.headless,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
      permissions: [],
    }
    const attempts: { label: string; opts: Parameters<typeof chromium.launchPersistentContext>[1] }[] =
      a.browser === 'custom'
        ? [{ label: a.browserPath, opts: { ...common, executablePath: a.browserPath } }]
        : a.browser === 'auto'
          ? [
              { label: 'Google Chrome', opts: { ...common, channel: 'chrome' } },
              { label: 'Microsoft Edge', opts: { ...common, channel: 'msedge' } },
              { label: 'Chromium', opts: { ...common } },
            ]
          : [{ label: a.browser, opts: a.browser === 'chromium' ? common : { ...common, channel: a.browser } }]
    const errors: string[] = []
    for (const t of attempts) {
      try {
        return await chromium.launchPersistentContext(this.ctx.paths.browserProfile, t.opts)
      } catch (err) {
        errors.push(`${t.label}: ${String(err).split('\n')[0]}`)
      }
    }
    this.ctx.log.warn('browser launch failed', { errors })
    throw new AppError('NO_BROWSER', 'OpenApplyr needs Google Chrome or Microsoft Edge to fill applications. Install one, or pick a browser in Settings, Applying.', { permanent: true, detail: errors.join('\n') })
  }

  async newPage(): Promise<Page> {
    if (!this.context) {
      this.opening ??= this.launch().then((c) => {
        this.context = c
        c.on('close', () => (this.context = null))
        return c
      })
      try {
        await this.opening
      } finally {
        this.opening = null
      }
    }
    const page = await this.context!.newPage()
    page.setDefaultTimeout(20_000)
    page.setDefaultNavigationTimeout(45_000)
    return page
  }

  async close(): Promise<void> {
    const c = this.context
    this.context = null
    await c?.close().catch(() => undefined)
  }
}

/** Hosts a run may navigate to: the posting's own site, ATS domains, and common sign-in providers. */
const ALWAYS_ALLOWED = [
  /(^|\.)greenhouse\.io$/,
  /(^|\.)lever\.co$/,
  /(^|\.)ashbyhq\.com$/,
  /\.myworkday(jobs|site)\.com$/,
  /(^|\.)workday\.com$/,
  /(^|\.)smartrecruiters\.com$/,
  /(^|\.)workable\.com$/,
  /(^|\.)recruitee\.com$/,
  /(^|\.)icims\.com$/,
  /(^|\.)bamboohr\.com$/,
  /(^|\.)(taleo|oraclecloud)\.(net|com)$/,
  /(^|\.)successfactors\.(com|eu)$/,
  /(^|\.)teamtailor\.com$/,
  /(^|\.)personio\.(de|com)$/,
  /(^|\.)breezy\.hr$/,
  /(^|\.)applytojob\.com$/,
  /(^|\.)rippling\.com$/,
  /^accounts\.google\.com$/,
  /^login\.microsoftonline\.com$/,
  /^login\.live\.com$/,
  /^appleid\.apple\.com$/,
]

const registrable = (h: string) => h.split('.').slice(-2).join('.')

export function navigationAllowed(target: string, jobUrl: string): boolean {
  let t: URL
  try {
    t = new URL(target)
  } catch {
    return false
  }
  if (t.protocol === 'about:' || t.protocol === 'data:' || t.protocol === 'blob:') return true
  if (t.protocol !== 'https:' && t.protocol !== 'http:') return false
  const h = t.hostname.toLowerCase()
  const job = new URL(jobUrl).hostname.toLowerCase()
  if (h === job || registrable(h) === registrable(job)) return true
  return ALWAYS_ALLOWED.some((re) => re.test(h))
}

/** Aborts top-level navigations away from the application's sites. */
export async function guardNavigation(page: Page, jobUrl: string, onBlocked: (url: string) => void): Promise<void> {
  await page.route('**/*', (route) => {
    const req = route.request()
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !navigationAllowed(req.url(), jobUrl)) {
      onBlocked(req.url())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
}
