import { describe, expect, it } from 'vitest'
import { Db } from '../core/db'
import { AppError } from '../core/errors'
import { silentLogger } from '../core/log'
import { Deferred, Queue, backoffMs } from './queue'
import { Worker } from './worker'

function setup(now = () => 1_000_000) {
  const db = new Db(':memory:')
  db.migrate()
  return { db, queue: new Queue(db, now) }
}

describe('Queue', () => {
  it('dedupes pending work and moves an existing task earlier when asked', () => {
    const { db, queue } = setup()
    const a = queue.enqueue('poll', { id: 1 }, { dedupeKey: 'poll:1', runAt: 2_000_000 })
    const b = queue.enqueue('poll', { id: 1 }, { dedupeKey: 'poll:1', runAt: 1_500_000 })
    expect(b).toBe(a)
    expect(db.get<{ run_at: number }>('SELECT run_at FROM tasks WHERE id = ?', [a])!.run_at).toBe(1_500_000)
  })

  it('claims by priority then time, respects the accept filter, and counts attempts on claim', () => {
    const { queue } = setup()
    queue.enqueue('low', {}, { priority: 0, runAt: 1 })
    queue.enqueue('high', {}, { priority: 5, runAt: 2 })
    queue.enqueue('future', {}, { runAt: 9_999_999 })
    expect(queue.claim(() => true)!.type).toBe('high')
    expect(queue.claim((t) => t !== 'low')).toBeNull()
    const low = queue.claim(() => true)!
    expect(low.type).toBe('low')
    expect(low.attempts).toBe(1)
  })

  it('retries with backoff, then fails permanently after max attempts', () => {
    const { queue } = setup()
    const id = queue.enqueue('x', {}, { maxAttempts: 2, runAt: 0 })
    queue.claim(() => true)
    expect(queue.fail(id, 'e1')).toBe(true)
    // Not due yet because of backoff.
    expect(queue.claim(() => true)).toBeNull()
  })

  it('marks permanent errors failed immediately', () => {
    const { db, queue } = setup()
    const id = queue.enqueue('x', {}, { runAt: 0 })
    queue.claim(() => true)
    expect(queue.fail(id, 'bad input', true)).toBe(false)
    expect(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status).toBe('failed')
  })

  it('recovers tasks interrupted by a crash without losing the attempt count', () => {
    const { db, queue } = setup()
    const id = queue.enqueue('x', {}, { runAt: 0 })
    queue.claim(() => true)
    expect(queue.recover()).toBe(1)
    const row = db.get<{ status: string; attempts: number }>('SELECT status, attempts FROM tasks WHERE id = ?', [id])!
    expect(row).toEqual({ status: 'pending', attempts: 1 })
  })

  it('backoff grows and is capped', () => {
    const fixed = () => 0.5
    expect(backoffMs(1, fixed)).toBe(30_000)
    expect(backoffMs(3, fixed)).toBe(120_000)
    expect(backoffMs(40, fixed)).toBe(6 * 3600_000)
  })
})

describe('Worker', () => {
  it('runs tasks, enforces concurrency, and retries or fails according to the error', async () => {
    const db = new Db(':memory:')
    db.migrate()
    const queue = new Queue(db)
    const worker = new Worker(queue, silentLogger)
    let active = 0
    let maxActive = 0
    const done: number[] = []
    worker.register(
      'job',
      async (p) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        done.push((p as { n: number }).n)
      },
      { concurrency: 2 },
    )
    worker.register('bad', async () => {
      throw new AppError('X', 'nope', { permanent: true })
    })
    for (let n = 0; n < 5; n++) queue.enqueue('job', { n })
    const badId = queue.enqueue('bad')
    worker.start(10)
    await new Promise((r) => setTimeout(r, 300))
    await worker.stop()
    expect(done.sort()).toEqual([0, 1, 2, 3, 4])
    expect(maxActive).toBe(2)
    expect(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [badId])!.status).toBe('failed')
  })

  it('times out a stuck task and aborts its signal', async () => {
    const db = new Db(':memory:')
    db.migrate()
    const queue = new Queue(db)
    const worker = new Worker(queue, silentLogger)
    let aborted = false
    worker.register(
      'stuck',
      (_p, ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          })
        }),
      { timeoutMs: 50 },
    )
    const id = queue.enqueue('stuck', {}, { maxAttempts: 1 })
    worker.start(10)
    await new Promise((r) => setTimeout(r, 200))
    await worker.stop()
    expect(aborted).toBe(true)
    const row = db.get<{ status: string; last_error: string }>('SELECT status, last_error FROM tasks WHERE id = ?', [id])!
    expect(row.status).toBe('failed')
    expect(row.last_error).toMatch(/Timed out/)
  })

  it('does not start new tasks while paused', async () => {
    const db = new Db(':memory:')
    db.migrate()
    const queue = new Queue(db)
    const worker = new Worker(queue, silentLogger)
    let ran = 0
    worker.register('t', async () => {
      ran++
    })
    worker.setPaused(true)
    queue.enqueue('t')
    worker.start(10)
    await new Promise((r) => setTimeout(r, 80))
    expect(ran).toBe(0)
    worker.setPaused(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(ran).toBe(1)
    await worker.stop()
  })

  it('puts a deferred task back for later without spending an attempt', async () => {
    const db = new Db(':memory:')
    db.migrate()
    const queue = new Queue(db)
    const worker = new Worker(queue, silentLogger)
    const later = Date.now() + 3600_000
    worker.register('paced', async () => {
      throw new Deferred(later, 'Outside active hours.')
    })
    const id = queue.enqueue('paced', {}, { maxAttempts: 1 })
    worker.start(10)
    await new Promise((r) => setTimeout(r, 80))
    await worker.stop()
    expect(db.get('SELECT status, run_at, attempts, last_error FROM tasks WHERE id = ?', [id])).toEqual({ status: 'pending', run_at: later, attempts: 0, last_error: 'Outside active hours.' })
  })
})
