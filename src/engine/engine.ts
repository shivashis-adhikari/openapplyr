import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Db } from './core/db'
import { Bus } from './core/events'
import { Http } from './core/http'
import { type Logger, createLogger } from './core/log'
import { Secrets } from './core/secrets'
import { SettingsStore } from './core/settings'
import type { HostClient } from './host'
import { Router } from './ipc/router'
import { Queue } from './scheduler/queue'
import { Worker } from './scheduler/worker'

export type EngineOptions = {
  dataDir: string
  dataKey: Buffer
  appVersion: string
  resourcesPath: string
  demo: boolean
  host: HostClient
  log?: Logger
  /** Tests pass ':memory:' */
  dbFile?: string
}

export type Paths = {
  data: string
  db: string
  logs: string
  documents: string
  evidence: string
  backups: string
  browserProfile: string
  resources: string
}

/**
 * Shared services every module receives. Modules are plain functions/classes that take this context;
 * there is no dependency-injection framework.
 */
export type Ctx = {
  db: Db
  bus: Bus
  log: Logger
  http: Http
  secrets: Secrets
  settings: SettingsStore
  queue: Queue
  worker: Worker
  router: Router
  host: HostClient
  paths: Paths
  appVersion: string
  demo: boolean
  now: () => number
}

export function createContext(o: EngineOptions): Ctx {
  const paths: Paths = {
    data: o.dataDir,
    db: o.dbFile ?? join(o.dataDir, 'openapplyr.db'),
    logs: join(o.dataDir, 'logs'),
    documents: join(o.dataDir, 'documents'),
    evidence: join(o.dataDir, 'evidence'),
    backups: join(o.dataDir, 'backups'),
    browserProfile: join(o.dataDir, 'browser-profile'),
    resources: o.resourcesPath,
  }
  for (const dir of [paths.logs, paths.documents, paths.evidence, paths.backups]) mkdirSync(dir, { recursive: true })
  const log = o.log ?? createLogger(paths.logs, { echo: !o.demo && process.env['OPENAPPLYR_LOG_ECHO'] === '1' })
  const db = new Db(paths.db)
  db.migrate()
  const bus = new Bus()
  const settings = new SettingsStore(db, bus)
  const queue = new Queue(db)
  const worker = new Worker(queue, log)
  worker.onChange = () => bus.changed('tasks')
  const http = new Http(o.appVersion, settings.get().discovery.maxRequestsPerSecond)
  return {
    db,
    bus,
    log,
    http,
    secrets: new Secrets(db, o.dataKey),
    settings,
    queue,
    worker,
    router: new Router(),
    host: o.host,
    paths,
    appVersion: o.appVersion,
    demo: o.demo,
    now: Date.now,
  }
}
