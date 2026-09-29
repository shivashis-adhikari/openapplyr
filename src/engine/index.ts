import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineToMain, HostInit, MainToEngine } from '../shared/host'
import { bootEngine } from './boot'
import { ParentPortHost } from './host'
import type { PortLike } from './ipc/server'

/**
 * Utility-process entry. Waits for `init` from main, boots the engine, then serves each renderer port
 * main hands over. Everything interesting lives in boot.ts so it can run in tests without Electron.
 */
type ParentPort = {
  on(event: 'message', listener: (e: { data: MainToEngine; ports: PortLike[] }) => void): void
  postMessage(msg: EngineToMain): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort
const post = (msg: EngineToMain) => parentPort.postMessage(msg)
const host = new ParentPortHost(post)

let booted: Awaited<ReturnType<typeof bootEngine>> | null = null
const waitingPorts: PortLike[] = []

parentPort.on('message', (e) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      void start(msg)
      return
    case 'renderer-port': {
      const port = e.ports[0]
      if (!port) return
      if (booted) booted.attachPort(port)
      else waitingPorts.push(port)
      return
    }
    case 'reply':
      host.handleReply(msg)
      return
    case 'power-event':
      booted?.onPowerEvent(msg.event)
      return
    case 'shutdown':
      void shutdown()
      return
  }
})

async function start(init: HostInit): Promise<void> {
  try {
    booted = await bootEngine({
      dataDir: init.dataDir,
      dataKey: Buffer.from(init.dataKey, 'base64'),
      appVersion: init.appVersion,
      resourcesPath: init.resourcesPath,
      demo: init.demo,
      host,
      onDeleteAll: async () => {
        await booted?.stop()
        for (const name of ['openapplyr.db', 'openapplyr.db-wal', 'openapplyr.db-shm', 'documents', 'evidence', 'browser-profile', 'backups', 'logs']) {
          rmSync(join(init.dataDir, name), { recursive: true, force: true })
        }
        // Main restarts the engine, which opens a fresh database.
        setTimeout(() => process.exit(0), 150)
      },
    })
    for (const p of waitingPorts.splice(0)) booted.attachPort(p)
    post({ type: 'ready' })
  } catch (err) {
    post({ type: 'fatal', message: err instanceof Error ? `${err.message}` : String(err) })
    setTimeout(() => process.exit(1), 100)
  }
}

async function shutdown(): Promise<void> {
  try {
    await booted?.stop()
  } finally {
    post({ type: 'shutdown-complete' })
    process.exit(0)
  }
}

process.on('unhandledRejection', (reason) => booted?.ctx.log.error('unhandled rejection', { reason }))
process.on('uncaughtException', (err) => {
  booted?.ctx.log.error('uncaught exception', { err })
  // State may be inconsistent; exit and let main restart us cleanly.
  setTimeout(() => process.exit(1), 50)
})
