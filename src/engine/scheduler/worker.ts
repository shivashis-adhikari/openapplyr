import { errorMessage, isPermanent } from '../core/errors'
import type { Logger } from '../core/log'
import { Deferred, type Queue, type TaskRow } from './queue'

export type TaskContext = { taskId: number; attempt: number; signal: AbortSignal }
export type TaskHandler = (payload: unknown, ctx: TaskContext) => Promise<void>
type Registration = { handler: TaskHandler; concurrency: number; timeoutMs: number; runWhenPaused: boolean }

/**
 * Pulls due tasks from the queue and runs them with per-type concurrency and timeouts.
 * Pausing stops new tasks from starting; running ones finish or observe their abort signal.
 */
export class Worker {
  private readonly registry = new Map<string, Registration>()
  private readonly running = new Map<string, number>()
  private readonly controllers = new Map<number, AbortController>()
  private timer: NodeJS.Timeout | null = null
  private paused = false
  private ticking = false
  onChange: () => void = () => {}

  constructor(
    private readonly queue: Queue,
    private readonly log: Logger,
  ) {}

  register(type: string, handler: TaskHandler, o: { concurrency?: number; timeoutMs?: number; runWhenPaused?: boolean } = {}): void {
    this.registry.set(type, {
      handler,
      concurrency: o.concurrency ?? 1,
      timeoutMs: o.timeoutMs ?? 5 * 60_000,
      runWhenPaused: o.runWhenPaused ?? false,
    })
  }

  start(intervalMs = 1000): void {
    this.queue.recover()
    this.timer = setInterval(() => this.kick(), intervalMs)
    this.kick()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.kick()
  }

  isBusy(type?: string): boolean {
    if (type) return (this.running.get(type) ?? 0) > 0
    return [...this.running.values()].some((n) => n > 0)
  }

  /** Starts as many due tasks as capacity allows. Safe to call often. */
  kick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      for (;;) {
        const task = this.queue.claim((type) => {
          const reg = this.registry.get(type)
          if (!reg) return false
          if (this.paused && !reg.runWhenPaused) return false
          return (this.running.get(type) ?? 0) < reg.concurrency
        })
        if (!task) break
        void this.run(task)
      }
    } catch (err) {
      this.log.error('worker tick failed', { err })
    } finally {
      this.ticking = false
    }
  }

  private async run(task: TaskRow): Promise<void> {
    const reg = this.registry.get(task.type)!
    this.running.set(task.type, (this.running.get(task.type) ?? 0) + 1)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.onChange()
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const timeoutMessage = `Timed out after ${Math.round(reg.timeoutMs / 1000)} seconds.`
    try {
      const payload = JSON.parse(task.payload) as unknown
      await Promise.race([
        reg.handler(payload, { taskId: task.id, attempt: task.attempts, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Reject before aborting: a handler that resolves on abort must not count as success.
            timedOut = true
            reject(new Error(timeoutMessage))
            controller.abort()
          }, reg.timeoutMs)
        }),
      ])
      if (timedOut) throw new Error(timeoutMessage)
      this.queue.complete(task.id)
    } catch (err) {
      if (err instanceof Deferred && !timedOut) {
        this.queue.defer(task.id, err.runAt, err.message)
        return
      }
      const retry = this.queue.fail(task.id, errorMessage(err), isPermanent(err))
      this.log[retry ? 'warn' : 'error'](`task ${task.type} failed`, { id: task.id, attempt: task.attempts, retry, err })
    } finally {
      clearTimeout(timer)
      this.controllers.delete(task.id)
      this.running.set(task.type, (this.running.get(task.type) ?? 1) - 1)
      this.onChange()
      setImmediate(() => this.kick())
    }
  }

  /** Cancels one running task (the Stop button on a run). */
  abort(taskId: number): boolean {
    const c = this.controllers.get(taskId)
    c?.abort()
    return !!c
  }

  async stop(graceMs = 4000): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.paused = true
    const deadline = Date.now() + graceMs
    while (this.isBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    for (const c of this.controllers.values()) c.abort()
  }
}
