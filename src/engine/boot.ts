import { registerAiHandlers } from './ai/handlers'
import { PriceBook } from './ai/prices'
import { Providers } from './ai/providers'
import { AiService } from './ai/service'
import { registerAppHandlers } from './app/handlers'
import { type Ctx, type EngineOptions, createContext } from './engine'
import { type PortLike, servePort } from './ipc/server'
import { registerProfileHandlers } from './profile/handlers'
import { join } from 'node:path'
import { credentials } from './integrations'
import { setDataDir } from './jobs/geo'
import { registerDiscoveryHandlers } from './match/handlers'
import { registerDocumentHandlers } from './docs/handlers'
import { registerPackageHandlers } from './packages/handlers'
import { registerApplyHandlers, runsFor } from './apply/handlers'
import { registerTrackerHandlers } from './tracker/handlers'
import { registerMailHandlers } from './mail/handlers'
import { registerOutreachHandlers } from './outreach/handlers'
import { registerPrepHandlers } from './prep/handlers'
import { seedDemo } from './demo/seed'
import { scoreNewJobs } from './match/pipeline'
import { Notifier } from './notify'
import { coreSchedules, dailyMaintenance } from './scheduler/schedules'
import { pollSource } from './sources/poller'
import { ensureAggregators, syncRegistry } from './sources/registry'
import type { Services } from './services'

export type BootOptions = EngineOptions & { onDeleteAll: () => Promise<void> }

export type Booted = {
  ctx: Ctx
  services: Services
  attachPort(port: PortLike): void
  onPowerEvent(event: 'suspend' | 'resume'): void
  stop(): Promise<void>
}

/** Builds every module, registers IPC handlers, and starts background work. */
export async function bootEngine(o: BootOptions): Promise<Booted> {
  const ctx = createContext(o)
  const stops: Array<() => Promise<void> | void> = []

  const prices = new PriceBook(ctx.db)
  const providers = new Providers(ctx.db, ctx.secrets, ctx.http, prices)
  const ai = new AiService(ctx.db, ctx.settings, ctx.log, ctx.bus, providers, prices, ctx.now)
  const services: Services = { prices, providers, ai }

  const notifier = new Notifier(ctx)
  setDataDir(join(ctx.paths.resources, 'data'))

  registerAppHandlers(ctx, o.onDeleteAll)
  registerAiHandlers(ctx, providers, prices)
  registerProfileHandlers(ctx, services)
  registerDiscoveryHandlers(ctx, services)
  registerDocumentHandlers(ctx, services)
  registerPackageHandlers(ctx, services)
  const apply = registerApplyHandlers(ctx, services, notifier)
  stops.push(() => apply.browser.close())
  registerTrackerHandlers(ctx, (id) => runsFor(ctx, id))
  registerMailHandlers(ctx, services, notifier)
  registerOutreachHandlers(ctx, services)
  registerPrepHandlers(ctx, services)

  ctx.worker.register('sources.poll', async (p, t) => void (await pollSource(ctx, (p as { id: number }).id, t.signal)), { concurrency: 4, timeoutMs: 3 * 60_000 })
  ctx.worker.register('match.score', async (_p, t) => void (await scoreNewJobs(ctx, services, notifier, t.signal)), { concurrency: 1, timeoutMs: 45 * 60_000 })
  ctx.worker.register('maintenance.daily', () => dailyMaintenance(ctx), { concurrency: 1, runWhenPaused: true })

  if (o.demo) {
    // The sample workspace is offline: no registry, no aggregators, only fictional data.
    await seedDemo(ctx, services).catch((err) => ctx.log.error('demo seed failed', { err }))
  } else {
    try {
      const added = syncRegistry(ctx)
      if (added) ctx.log.info('registry synced', { added })
    } catch (err) {
      ctx.log.warn('registry sync failed', { err })
    }
    ensureAggregators(ctx, credentials(ctx))
  }
  const schedules = coreSchedules(ctx, notifier)
  stops.push(() => schedules.stop())

  const missing = ctx.router.missing()
  if (missing.length) ctx.log.warn('procedures without handlers', { missing })

  const s = ctx.settings.get()
  ctx.worker.setPaused(s.paused)
  ctx.worker.start()
  schedules.start()
  ctx.log.info('engine started', { version: o.appVersion, demo: o.demo })

  let stopped = false
  return {
    ctx,
    services,
    attachPort: (port) => servePort(port, ctx.router, ctx.bus, ctx.log),
    onPowerEvent(event) {
      ctx.log.info(`power ${event}`)
      if (event === 'resume') ctx.worker.kick()
    },
    async stop() {
      if (stopped) return
      stopped = true
      await ctx.worker.stop()
      for (const fn of stops.reverse()) await fn()
      ctx.db.close()
    },
  }
}
