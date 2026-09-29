import type { EngineToRenderer, RendererToEngine } from '../../shared/host'
import { toWire } from '../core/errors'
import type { Bus } from '../core/events'
import type { Logger } from '../core/log'
import type { Router } from './router'

/** Minimal port shape shared by Electron's MessagePortMain and test doubles. */
export type PortLike = {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  postMessage(msg: unknown): void
  start(): void
}

export function servePort(port: PortLike, router: Router, bus: Bus, log: Logger): void {
  const post = (msg: EngineToRenderer) => {
    try {
      port.postMessage(msg)
    } catch (err) {
      log.warn('could not post to renderer', { err })
    }
  }
  port.on('message', (e) => {
    const msg = e.data as RendererToEngine
    if (!msg || msg.type !== 'call' || typeof msg.id !== 'number' || typeof msg.name !== 'string') return
    const started = Date.now()
    router.handle(msg.name, msg.input).then(
      (value) => post({ type: 'result', id: msg.id, ok: true, value }),
      (err) => {
        const wire = toWire(err)
        if (wire.code === 'INTERNAL') log.error(`call ${msg.name} failed`, { err, ms: Date.now() - started })
        post({ type: 'result', id: msg.id, ok: false, error: wire })
      },
    )
  })
  const off = bus.on((topic, data) => post({ type: 'event', topic, data }))
  port.on('close', off)
  port.start()
}
