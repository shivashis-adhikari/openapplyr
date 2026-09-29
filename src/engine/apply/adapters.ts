import type { Frame } from 'playwright-core'
import type { ApplyContext } from './context'
import { type PageButton, type PageState, readPage } from './form'
import { type RunOutcome, runForm, settle } from './runner'

/**
 * One per applicant tracking system. Adapters only know how to reach the form and the site's quirks;
 * reading, filling, asking and submitting are shared (runner.ts), so every ATS gets the same rules.
 */
export type ApplyAdapter = {
  id: string
  label: string
  matches(url: URL): boolean
  /** The page that holds the form, for a posting URL. */
  formUrl?(url: URL): string
  run(ctx: ApplyContext, workday?: TenantAccounts): Promise<RunOutcome>
}

/** Credentials per Workday tenant, created by OpenApplyr and stored encrypted. */
export type TenantAccounts = {
  get(host: string): { username: string; password: string } | null
  create(host: string, username: string): { username: string; password: string }
}

const host = (u: URL) => u.hostname.toLowerCase()

async function goto(ctx: ApplyContext, url: string): Promise<void> {
  ctx.step('navigate', url)
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
}

/** Clicks the first visible button or link whose text matches, if any. Never a submit control. */
async function clickIf(ctx: ApplyContext, frame: Frame, re: RegExp, what: string): Promise<boolean> {
  const s = await readPage(frame)
  const b = s.buttons.find((x) => re.test(x.text))
  if (b) {
    await ctx.click(frame.locator(`[data-oa-button="${b.id}"]`).first(), what)
    await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
    return true
  }
  const link = frame.getByRole('link', { name: re }).first()
  if (await link.isVisible().catch(() => false)) {
    ctx.step('click', what)
    await link.click()
    await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
    return true
  }
  return false
}

const main = (ctx: ApplyContext) => () => ctx.page.mainFrame()

// ---------------------------------------------------------------------------

export const greenhouse: ApplyAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse',
  matches: (u) => /(^|\.)greenhouse\.io$/.test(host(u)) || u.searchParams.has('gh_jid'),
  async run(ctx) {
    await goto(ctx, ctx.job.url)
    // Company career sites embed the Greenhouse form in an iframe.
    const embedded = () => ctx.page.frames().find((f) => /greenhouse\.io\/(embed\/)?job_app|grnhse_iframe/.test(f.url() + f.name())) ?? ctx.page.mainFrame()
    await settle(ctx.page, embedded())
    return runForm(ctx, { getFrame: embedded })
  },
}

export const lever: ApplyAdapter = {
  id: 'lever',
  label: 'Lever',
  matches: (u) => /^jobs(\.eu)?\.lever\.co$/.test(host(u)),
  formUrl: (u) => (u.pathname.replace(/\/$/, '').endsWith('/apply') ? u.toString() : `${u.origin}${u.pathname.replace(/\/$/, '')}/apply`),
  async run(ctx) {
    await goto(ctx, lever.formUrl!(new URL(ctx.job.url)))
    return runForm(ctx, {
      getFrame: main(ctx),
      // Lever's send button is a plain button with id btn-submit.
      submitButton: (s: PageState): PageButton | null => s.buttons.find((b) => /submit application/i.test(b.text)) ?? null,
    })
  },
}

export const ashby: ApplyAdapter = {
  id: 'ashby',
  label: 'Ashby',
  matches: (u) => host(u) === 'jobs.ashbyhq.com',
  formUrl: (u) => (u.pathname.endsWith('/application') ? u.toString() : `${u.origin}${u.pathname.replace(/\/$/, '')}/application`),
  async run(ctx) {
    await goto(ctx, ashby.formUrl!(new URL(ctx.job.url)))
    return runForm(ctx, { getFrame: main(ctx) })
  },
}

export const recruitee: ApplyAdapter = {
  id: 'recruitee',
  label: 'Recruitee',
  matches: (u) => host(u).endsWith('.recruitee.com'),
  formUrl: (u) => (/\/c\/new\/?$/.test(u.pathname) ? u.toString() : `${u.origin}${u.pathname.replace(/\/$/, '')}/c/new`),
  async run(ctx) {
    await goto(ctx, recruitee.formUrl!(new URL(ctx.job.url)))
    return runForm(ctx, { getFrame: main(ctx) })
  },
}

export const workable: ApplyAdapter = {
  id: 'workable',
  label: 'Workable',
  matches: (u) => host(u) === 'apply.workable.com' || host(u).endsWith('.workable.com'),
  formUrl: (u) => (u.pathname.replace(/\/$/, '').endsWith('/apply') ? u.toString() : `${u.origin}${u.pathname.replace(/\/$/, '')}/apply/`),
  async run(ctx) {
    await goto(ctx, workable.formUrl!(new URL(ctx.job.url)))
    await clickIf(ctx, ctx.page.mainFrame(), /^(accept|accept all|agree)$/i, 'Closed the cookie banner')
    return runForm(ctx, { getFrame: main(ctx) })
  },
}

export const smartrecruiters: ApplyAdapter = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters',
  matches: (u) => /(^|\.)smartrecruiters\.com$/.test(host(u)),
  async run(ctx) {
    await goto(ctx, ctx.job.url)
    await clickIf(ctx, ctx.page.mainFrame(), /^(i'?m interested|apply( now)?)$/i, 'Opened the application form')
    return runForm(ctx, { getFrame: main(ctx) })
  },
}

/**
 * Workday: one account per company tenant, then a multi-step wizard. The account is created with a
 * generated password (kept encrypted and visible in Settings); a verification email is handled by the
 * user or by the connected mailbox.
 */
export const workday: ApplyAdapter = {
  id: 'workday',
  label: 'Workday',
  matches: (u) => /\.myworkday(jobs|site)\.com$/.test(host(u)),
  async run(ctx, accounts) {
    await goto(ctx, ctx.job.url)
    const f = ctx.page.mainFrame()
    await settle(ctx.page, f)
    await clickIf(ctx, f, /^apply$/i, 'Apply')
    await clickIf(ctx, f, /^apply manually$/i, 'Apply manually')
    const tenant = host(new URL(ctx.job.url))
    const state = await settle(ctx.page, f)
    const hasPassword = (await f.locator('input[type=password]').count()) > 0
    if (hasPassword && accounts) {
      const email = (await ctx.answerFor({ fieldName: 'email', label: 'Email', type: 'email', required: true, options: [] })).answer
      const existing = accounts.get(tenant)
      // Workday opens on sign-in; a first application needs the create-account form instead.
      if (!existing) await clickIf(ctx, f, /^create account$/i, 'Create account')
      const acct = existing ?? accounts.create(tenant, email)
      await f.locator('[data-automation-id="email"], input[type=email]').first().fill(acct.username)
      const pw = f.locator('input[type=password]')
      for (let i = 0; i < (await pw.count()); i++) await pw.nth(i).fill(acct.password)
      ctx.step('fill', `Workday account for ${tenant}: ${acct.username}`)
      const consent = f.locator('[data-automation-id="createAccountCheckbox"]')
      if (await consent.count()) await consent.check({ force: true })
      const go = f.locator('[data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"]').first()
      if (await go.count()) {
        ctx.step('click', existing ? 'Signed in' : 'Created the account')
        await go.click({ force: true })
        await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined)
      }
      const after = await readPage(f)
      if (/verify your (email|account)|verification email/i.test(after.text)) {
        const reply = await ctx.askUser(`Workday sent a verification email to ${acct.username} for ${ctx.job.company}. Open the link in that email, then press Continue.`, 'unexpected')
        if (reply.kind === 'stop') return { status: 'failed', error: 'Stopped at the Workday account step.' }
      }
    } else if (!state.fields.length) {
      const reply = await ctx.askUser(`Sign in to ${ctx.job.company}'s Workday site in the browser window, then press Continue.`, 'unexpected')
      if (reply.kind === 'stop') return { status: 'failed', error: 'Stopped at the Workday sign-in step.' }
    }
    return runForm(ctx, { getFrame: main(ctx), maxPages: 12 })
  },
}

/** Any other site: open the posting, press its Apply button if the form is not on the page, then run the form. */
export const generic: ApplyAdapter = {
  id: 'generic',
  label: 'Other site',
  matches: () => true,
  async run(ctx) {
    await goto(ctx, ctx.job.url)
    const f = ctx.page.mainFrame()
    let state = await settle(ctx.page, f)
    // A sign-in page is handled by runForm, which hands it to the person.
    const noForm = () => !state.login && state.fields.filter((x) => x.kind !== 'file').length < 2
    if (noForm()) {
      if (await clickIf(ctx, f, /^(apply( now| for this (job|role|position))?|i'?m interested)$/i, 'Opened the application form')) state = await settle(ctx.page, ctx.page.mainFrame())
    }
    if (noForm() && (await ctx.findForm())) state = await settle(ctx.page, ctx.page.mainFrame())
    if (noForm()) {
      const reply = await ctx.askUser(`Open the application form for ${ctx.job.title} at ${ctx.job.company} in the browser window, then press Continue.`, 'unexpected')
      if (reply.kind === 'stop') return { status: 'failed', error: 'Stopped before the form was found.' }
    }
    return runForm(ctx, { getFrame: main(ctx) })
  },
}

export const ADAPTERS: ApplyAdapter[] = [greenhouse, lever, ashby, workday, smartrecruiters, workable, recruitee]

export function adapterFor(url: string): ApplyAdapter {
  try {
    const u = new URL(url)
    return ADAPTERS.find((a) => a.matches(u)) ?? generic
  } catch {
    return generic
  }
}
