import { type UtilityProcess, type WebContents, MessageChannelMain, utilityProcess } from 'electron'
import type { EngineToMain, HostInit, HostMethod, MainToEngine } from '../shared/host'

type RequestHandler = (method: HostMethod, params: unknown) => Promise<unknown>

/**
 * Owns the engine utility process: starts it, hands each window a direct MessagePort to it,
 * answers its host requests (PDF, notifications, power), and restarts it if it crashes.
 */
export class EngineHost {
  private child: UtilityProcess | null = null
  private readonly windows = new Set<WebContents>()
  private crashTimes: number[] = []
  private quitting = false
  private readyResolve: (() => void) | null = null
  ready: Promise<void>

  constructor(
    private readonly entry: string,
    private readonly init: Omit<HostInit, 'type'>,
    private readonly onRequest: RequestHandler,
    private readonly onFatal: (message: string) => void,
  ) {
    this.ready = new Promise((r) => (this.readyResolve = r))
  }

  start(): void {
    const child = utilityProcess.fork(this.entry, [], { serviceName: 'OpenApplyr Engine', stdio: 'inherit' })
    this.child = child
    this.post({ type: 'init', ...this.init })
    child.on('message', (msg: EngineToMain) => void this.handle(msg))
    child.on('exit', (code) => this.onExit(code))
    for (const wc of this.windows) this.connect(wc)
  }

  /** Gives a page its own port to the engine: on every page load, and for every window again after a restart. */
  attach(wc: WebContents): void {
    if (!this.windows.has(wc)) {
      this.windows.add(wc)
      wc.once('destroyed', () => this.windows.delete(wc))
    }
    this.connect(wc)
  }

  send(msg: MainToEngine): void {
    this.post(msg)
  }

  async stop(): Promise<void> {
    this.quitting = true
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 6000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.post({ type: 'shutdown' })
    })
  }

  private connect(wc: WebContents): void {
    if (!this.child || wc.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    this.child.postMessage({ type: 'renderer-port' } satisfies MainToEngine, [port1])
    wc.postMessage('engine-port', null, [port2])
  }

  private post(msg: MainToEngine): void {
    this.child?.postMessage(msg)
  }

  private async handle(msg: EngineToMain): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.readyResolve?.()
        return
      case 'fatal':
        this.onFatal(msg.message)
        return
      case 'shutdown-complete':
        return
      case 'request': {
        try {
          const value = await this.onRequest(msg.method, msg.params)
          this.post({ type: 'reply', id: msg.id, ok: true, value })
        } catch (err) {
          this.post({ type: 'reply', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
  }

  private onExit(code: number): void {
    this.child = null
    if (this.quitting) return
    const now = Date.now()
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < 60_000), now]
    if (this.crashTimes.length > 3) {
      this.onFatal(`The engine stopped ${this.crashTimes.length} times in a minute (last exit code ${code}). See the log file for details.`)
      return
    }
    setTimeout(() => this.start(), 500)
  }
}
