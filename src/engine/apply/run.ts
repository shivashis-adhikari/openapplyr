import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PreparedAnswer, RunMode, RunStatus, RunStep } from '../../shared/domain'
import { resolveForm } from '../answers/resolve'
import { json } from '../core/db'
import { AppError, errorMessage, isPermanent } from '../core/errors'
import type { Ctx } from '../engine'
import { defaultTemplate, renderLetter, renderResume } from '../docs/store'
import { jobCountry } from '../packages/prepare'
import { huntFor } from '../match/hunts'
import type { Notifier } from '../notify'
import { loadProfile } from '../profile/store'
import { Deferred } from '../scheduler/queue'
import type { Services } from '../services'
import { adapterFor as sourceAdapterFor } from '../sources/index'
import { credentials } from '../integrations'
import { huntQueries } from '../match/hunts'
import { addEvent } from '../tracker/applications'
import { type TenantAccounts, adapterFor } from './adapters'
import { type BrowserManager, guardNavigation } from './browser'
import { ApplyContext, type RunFiles, StoppedByUser, type UserReply } from './context'
import { findForm } from './agent'
import { readPage } from './form'
import { nextSlot } from './pacing'
import { type RunOutcome, looksDone } from './runner'

export type ApplyPayload = { applicationId: number; mode?: RunMode | undefined; manual?: boolean | undefined }

class Paused extends Error {}

type AppRow = {
  id: number
  job_id: number | null
  package_id: number | null
  hunt_id: number | null
  company_id: number | null
  company_name: string
  title: string
  url: string | null
  status: string
  archived: number
}

/** Generated tenant passwords: long, random, and meeting common rules (upper, lower, digit, symbol). */
export function generatePassword(): string {
  const body = randomBytes(18).toString('base64url').replace(/[-_]/g, '')
  return `${body.slice(0, 14)}Aa7!`
}

/**
 * Runs one application: pacing, posting check, files, the browser, the adapter, evidence and the
 * outcome. At most one run waits for the user at a time per run id; replies arrive through reply().
 */
export class ApplyService {
  private readonly waiting = new Map<number, (r: UserReply | { kind: 'timeout' }) => void>()
  private readonly controllers = new Map<number, AbortController>()

  constructor(
    private readonly ctx: Ctx,
    private readonly s: Services,
    private readonly notifier: Notifier | null,
    readonly browser: BrowserManager,
    private readonly files?: (app: AppRow) => Promise<RunFiles>,
  ) {
    // Runs cut short by a quit or crash: the task queue re-runs them from the start.
    const t = ctx.now()
    ctx.db.run("UPDATE runs SET status = 'stopped', ended_at = ?, error = 'OpenApplyr was closed during this run.' WHERE status IN ('running', 'needs_user')", [t])
    ctx.db.run("UPDATE applications SET status = 'queued' WHERE status = 'applying'")
  }

  isWaiting(runId: number): boolean {
    return this.waiting.has(runId)
  }

  reply(runId: number, r: UserReply): boolean {
    const w = this.waiting.get(runId)
    if (!w) return false
    w(r)
    return true
  }

  stop(runId: number): boolean {
    const c = this.controllers.get(runId)
    if (!c) return false
    c.abort()
    this.waiting.get(runId)?.({ kind: 'stop' })
    return true
  }

  private tenantAccounts(): TenantAccounts {
    const { db, secrets } = this.ctx
    return {
      get: (host) => {
        const row = db.get<{ username: string; secret_id: number }>('SELECT username, secret_id FROM ats_accounts WHERE host = ?', [host])
        if (!row) return null
        db.run('UPDATE ats_accounts SET last_used_at = ? WHERE host = ?', [this.ctx.now(), host])
        return { username: row.username, password: secrets.get(row.secret_id) ?? '' }
      },
      create: (host, username) => {
        const password = generatePassword()
        const secretId = secrets.put(password)
        db.run('INSERT INTO ats_accounts (host, username, secret_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET username = excluded.username, secret_id = excluded.secret_id', [
          host,
          username,
          secretId,
          this.ctx.now(),
          this.ctx.now(),
        ])
        return { username, password }
      },
    }
  }

  private async defaultFiles(app: AppRow): Promise<RunFiles> {
    const pkg = app.package_id ? this.ctx.db.get<{ resume_id: number | null; cover_letter_id: number | null }>('SELECT resume_id, cover_letter_id FROM packages WHERE id = ?', [app.package_id]) : undefined
    if (!pkg?.resume_id) throw new AppError('NO_RESUME', 'This application has no resume attached.', { permanent: true })
    const { pdfPath } = await renderResume(this.ctx, pkg.resume_id)
    const coverLetter = pkg.cover_letter_id ? await renderLetter(this.ctx, pkg.cover_letter_id, defaultTemplate(this.ctx).pageSize) : null
    return { resume: pdfPath, coverLetter }
  }

  /** Is the posting still open? Uses the source's own check when there is one. Unknown counts as open. */
  private async stillOpen(jobId: number, signal: AbortSignal): Promise<boolean> {
    const j = this.ctx.db.get<{ source_id: number | null; source_kind: string; external_id: string; url: string; meta: string; closed_at: number | null }>(
      'SELECT source_id, source_kind, external_id, url, meta, closed_at FROM jobs WHERE id = ?',
      [jobId],
    )
    if (!j) return false
    if (j.closed_at) return false
    try {
      const adapter = sourceAdapterFor(j.source_kind)
      const src = j.source_id ? this.ctx.db.get<{ config: string }>('SELECT config FROM sources WHERE id = ?', [j.source_id]) : null
      if (!adapter.isOpen || !src) return true
      return await adapter.isOpen({ externalId: j.external_id, url: j.url, meta: json.parse(j.meta, {}) }, json.parse(src.config, {}), {
        http: this.ctx.http,
        now: this.ctx.now(),
        signal,
        queries: huntQueries(this.ctx.db),
        credentials: credentials(this.ctx),
      })
    } catch {
      return true
    }
  }

  /** Queue task handler for 'apply.run'. */
  async run(p: ApplyPayload, signal: AbortSignal, attempt = 1): Promise<void> {
    const { db } = this.ctx
    const app = db.get<AppRow>('SELECT * FROM applications WHERE id = ?', [p.applicationId])
    if (!app || app.archived || !app.url || ['applied', 'applied_unverified'].includes(app.status)) return
    const hunt = huntFor(db, app.hunt_id)
    const host = new URL(app.url).hostname
    // Sample jobs and documents are made up (the documents come from a stand-in model), so the
    // sample workspace only ever fills local test forms.
    if (this.ctx.demo && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      if (!db.get("SELECT 1 FROM events WHERE application_id = ? AND type = 'note' AND json_extract(data, '$.text') LIKE 'The sample workspace%'", [app.id])) {
        addEvent(db, app.id, 'note', 'app', { text: 'The sample workspace does not send applications. Its jobs and documents are made up.' }, this.ctx.now())
      }
      this.ctx.bus.changed('applications')
      return
    }
    const slot = nextSlot(this.ctx, { id: app.id, huntId: app.hunt_id, companyId: app.company_id, host }, hunt.config, !!p.manual)
    if (slot) {
      db.run("UPDATE applications SET status = 'queued' WHERE id = ?", [app.id])
      throw new Deferred(slot.at, slot.reason)
    }

    if (app.job_id && !(await this.stillOpen(app.job_id, signal))) {
      db.tx(() => {
        db.run('UPDATE jobs SET closed_at = COALESCE(closed_at, ?) WHERE id = ?', [this.ctx.now(), app.job_id])
        db.run("UPDATE applications SET status = 'failed', archived = 1 WHERE id = ?", [app.id])
        addEvent(db, app.id, 'closed', 'app', { note: 'The posting closed before OpenApplyr could apply.' }, this.ctx.now())
        if (app.package_id) db.run("UPDATE packages SET status = 'expired' WHERE id = ?", [app.package_id])
      })
      this.ctx.bus.changed('applications', 'packages')
      return
    }

    const automation = this.ctx.settings.get().automation
    const rampRun = !p.mode && hunt.mode !== 'manual' && automation.trustRampRemaining > 0
    const mode: RunMode = p.mode ?? (hunt.mode === 'manual' ? 'assisted' : rampRun ? 'dry_run' : 'submit')
    const adapter = adapterFor(app.url)
    const runId = db.run("INSERT INTO runs (application_id, package_id, job_id, adapter, mode, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)", [
      app.id,
      app.package_id,
      app.job_id,
      adapter.id,
      mode,
      this.ctx.now(),
    ]).lastInsertRowid
    const steps: RunStep[] = []
    const onStep = (st: RunStep) => {
      steps.push(st)
      db.run('UPDATE runs SET steps = ? WHERE id = ?', [JSON.stringify(steps.slice(-400)), runId])
      this.ctx.bus.changed('runs')
    }
    const setStatus = (run: RunStatus, appStatus: string | null, extra: { question?: string | null; error?: string | null; ended?: boolean } = {}) => {
      db.run(`UPDATE runs SET status = ?, question = ?, error = ?${extra.ended ? ', ended_at = ?' : ''} WHERE id = ?`, [
        run,
        extra.question ?? null,
        extra.error ?? null,
        ...(extra.ended ? [this.ctx.now()] : []),
        runId,
      ])
      if (appStatus) db.run('UPDATE applications SET status = ?, last_activity_at = ? WHERE id = ?', [appStatus, this.ctx.now(), app.id])
      this.ctx.bus.changed('runs', 'applications')
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort)
    this.controllers.set(runId, controller)
    setStatus('running', 'applying')
    addEvent(db, app.id, 'run_started', 'app', { runId, mode, adapter: adapter.id }, this.ctx.now())
    await this.ctx.host.request('power', { block: true }).catch(() => null)

    const evidenceDir = join(this.ctx.paths.evidence, String(app.id), String(runId))
    const pkgAnswers = app.package_id ? json.parse<PreparedAnswer[]>(db.get<{ answers: string }>('SELECT answers FROM packages WHERE id = ?', [app.package_id])?.answers, []) : []
    const job = app.job_id ? db.get<{ title: string; company_name: string; company_id: number | null; description_md: string; locations: string }>('SELECT * FROM jobs WHERE id = ?', [app.job_id]) : undefined
    const { profile } = loadProfile(db)
    let page: Awaited<ReturnType<BrowserManager['newPage']>> | null = null
    let keepOpen = false

    const askUser = async (question: string, _kind: string, field?: { name: string; label: string }): Promise<UserReply> => {
      setStatus('needs_user', 'needs_user', { question })
      addEvent(db, app.id, 'needs_user', 'run', { runId, question, fieldName: field?.name ?? null, label: field?.label ?? null }, this.ctx.now())
      void this.notifier?.needsYou(`${app.company_name}: ${app.title}`, question, `#/activity?run=${runId}`)
      const timeoutMs = this.ctx.settings.get().automation.needsUserTimeoutMinutes * 60_000
      const reply = await new Promise<UserReply | { kind: 'timeout' }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        this.waiting.set(runId, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
      })
      this.waiting.delete(runId)
      if (reply.kind === 'timeout') throw new Paused()
      setStatus('running', 'applying')
      return reply
    }

    try {
      const files = await (this.files ?? ((a) => this.defaultFiles(a)))(app)
      page = await this.browser.newPage()
      await guardNavigation(page, app.url, (url) => onStep({ at: this.ctx.now(), kind: 'error', text: `Blocked a jump to ${new URL(url).hostname}.` }))
      const apply: ApplyContext = new ApplyContext({
        findForm: () => findForm(apply, this.s.ai),
        page,
        mode,
        job: { title: app.title, company: app.company_name, url: app.url },
        answers: pkgAnswers,
        resolve: async (q) =>
          (
            await resolveForm(
              [q],
              {
                profile,
                job: { title: app.title, company: app.company_name, companyId: app.company_id, country: job ? jobCountry(job) : null, description: job?.description_md ?? '' },
                db,
                letterText: null,
                allowGenerated: hunt.mode !== 'autopilot' || hunt.config.generatedAnswersInAutopilot,
              },
              this.s.ai,
              { signal: controller.signal },
            )
          )[0]!,
        files,
        evidenceDir,
        signal: controller.signal,
        onStep,
        askUser,
        now: this.ctx.now,
      })
      onStep({ at: this.ctx.now(), kind: 'info', text: `${adapter.label} form, ${mode === 'dry_run' ? 'dry run' : mode === 'assisted' ? 'you submit' : 'submitting'}.` })
      let outcome: RunOutcome = await adapter.run(apply, this.tenantAccounts())
      if (outcome.status === 'ready' && mode === 'assisted') {
        keepOpen = true
        outcome = await this.watchAssisted(apply, runId, askUser)
      }
      this.finish(app, runId, mode, outcome, evidenceDir, setStatus, rampRun)
    } catch (err) {
      if (err instanceof Paused) {
        setStatus('paused', 'needs_user', { question: db.get<{ question: string }>('SELECT question FROM runs WHERE id = ?', [runId])?.question ?? null, ended: true })
        onStep({ at: this.ctx.now(), kind: 'info', text: 'Paused: no answer in time. Answer the question, then run it again.' })
      } else if (err instanceof StoppedByUser || controller.signal.aborted) {
        setStatus('stopped', 'failed', { error: 'Stopped.', ended: true })
        addEvent(db, app.id, 'stopped', 'user', { runId }, this.ctx.now())
      } else {
        const message = errorMessage(err)
        const retry = !isPermanent(err) && attempt < 3
        setStatus('failed', retry ? 'queued' : 'failed', { error: message, ended: true })
        onStep({ at: this.ctx.now(), kind: 'error', text: message })
        addEvent(db, app.id, 'run_failed', 'app', { runId, error: message, retry }, this.ctx.now())
        if (retry) throw err
        void this.notifier?.needsYou(`Could not apply: ${app.company_name}`, message, `#/activity?run=${runId}`)
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.controllers.delete(runId)
      if (page && !keepOpen) await page.close().catch(() => undefined)
      if (!this.controllers.size) await this.ctx.host.request('power', { block: false }).catch(() => null)
    }
  }

  /** Assisted fill: the user presses submit in the browser; the run watches for the confirmation. */
  private async watchAssisted(apply: ApplyContext, runId: number, askUser: (q: string, k: string) => Promise<UserReply>): Promise<RunOutcome> {
    const formUrl = apply.page.url()
    let replied: UserReply | null = null
    // Resolves when the user presses Continue or Stop, or the wait times out (treated as Continue).
    void askUser(`Review the filled form for ${apply.job.title} at ${apply.job.company} and submit it in the browser window. OpenApplyr records it when the confirmation appears.`, 'unexpected')
      .then((r) => (replied = r))
      .catch(() => (replied = { kind: 'continue' }))
    while (!replied && !apply.page.isClosed()) {
      try {
        const s = await readPage(apply.page.mainFrame())
        if (looksDone(s, formUrl)) {
          this.waiting.get(runId)?.({ kind: 'continue' })
          await apply.screenshot('after-submit')
          return { status: 'submitted', confirmation: { text: s.title, url: s.url } }
        }
      } catch {
        /* navigating */
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    if ((replied as UserReply | null)?.kind === 'stop') throw new StoppedByUser()
    return { status: 'unverified', note: 'No confirmation was seen. If you submitted it, mark it as applied.' }
  }

  private finish(app: AppRow, runId: number, mode: RunMode, o: RunOutcome, evidenceDir: string, setStatus: (r: RunStatus, a: string | null, e?: { question?: string | null; error?: string | null; ended?: boolean }) => void, rampRun: boolean): void {
    const { db } = this.ctx
    const now = this.ctx.now()
    const shot = existsSync(join(evidenceDir, 'after-submit.jpg')) ? join(evidenceDir, 'after-submit.jpg') : null
    switch (o.status) {
      case 'submitted':
      case 'unverified': {
        const verified = o.status === 'submitted'
        setStatus('submitted', verified ? 'applied' : 'applied_unverified', { ended: true })
        db.run('UPDATE applications SET applied_at = ?, method = ?, confirmation = ?, evidence_dir = ? WHERE id = ?', [
          now,
          mode === 'assisted' ? 'assisted' : 'agent',
          JSON.stringify(verified ? { ...o.confirmation, screenshot: shot } : { text: o.note, url: '', screenshot: shot }),
          evidenceDir,
          app.id,
        ])
        if (app.package_id) db.run("UPDATE packages SET status = 'applied' WHERE id = ?", [app.package_id])
        addEvent(db, app.id, verified ? 'applied' : 'applied_unverified', 'run', { runId }, now)
        if (huntFor(db, app.hunt_id).config.outreach.enabled) this.ctx.queue.enqueue('outreach.plan', { applicationId: app.id }, { dedupeKey: `outreach.plan:${app.id}`, runAt: now + 10 * 60_000 })
        break
      }
      case 'ready':
        setStatus('dry_run_done', 'needs_user', { question: 'Dry run finished. Check what was filled, then send it for real.', ended: true })
        db.run('UPDATE applications SET evidence_dir = ? WHERE id = ?', [evidenceDir, app.id])
        addEvent(db, app.id, 'dry_run', 'run', { runId }, now)
        if (rampRun) {
          const left = Math.max(0, this.ctx.settings.get().automation.trustRampRemaining - 1)
          this.ctx.settings.update({ automation: { trustRampRemaining: left } })
        }
        break
      case 'failed':
        setStatus('failed', 'failed', { error: o.error, ended: true })
        addEvent(db, app.id, 'run_failed', 'run', { runId, error: o.error }, now)
        void this.notifier?.needsYou(`Could not apply: ${app.company_name}`, o.error, `#/activity?run=${runId}`)
        break
    }
    this.ctx.bus.changed('applications', 'runs', 'packages')
  }
}

export function evidenceFiles(dir: string | null): { name: string; path: string }[] {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir).map((name) => ({ name, path: join(dir, name) }))
}
