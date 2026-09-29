import type { Db } from '../core/db'

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export type TaskRow = {
  id: number
  type: string
  payload: string
  dedupe_key: string | null
  priority: number
  run_at: number
  status: TaskStatus
  attempts: number
  max_attempts: number
  last_error: string | null
  locked_at: number | null
  created_at: number
  finished_at: number | null
}

/** Thrown by a task handler that cannot run yet (pacing, active hours). Not an attempt, not an error. */
export class Deferred extends Error {
  constructor(
    readonly runAt: number,
    reason: string,
  ) {
    super(reason)
    this.name = 'Deferred'
  }
}

export type EnqueueOptions = { runAt?: number; priority?: number; dedupeKey?: string; maxAttempts?: number }

/** Exponential backoff with jitter: 30s, 60s, 2m, 4m... capped at 6h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(6 * 3600_000, 30_000 * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.8 + random() * 0.4))
}

/**
 * Durable task queue in SQLite. `dedupe_key` is unique among pending/running tasks, so scheduling the
 * same work twice is a no-op. Attempts are counted when a task is claimed, which means a crash
 * mid-task still counts toward max_attempts and a poison task cannot loop forever.
 */
export class Queue {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(type: string, payload: unknown = {}, o: EnqueueOptions = {}): number {
    const runAt = o.runAt ?? this.now()
    if (o.dedupeKey) {
      const existing = this.db.get<{ id: number; run_at: number; status: TaskStatus }>(
        "SELECT id, run_at, status FROM tasks WHERE dedupe_key = ? AND status IN ('pending', 'running')",
        [o.dedupeKey],
      )
      if (existing) {
        if (existing.status === 'pending' && runAt < existing.run_at) {
          this.db.run('UPDATE tasks SET run_at = ? WHERE id = ?', [runAt, existing.id])
        }
        return existing.id
      }
    }
    return this.db.run(
      `INSERT INTO tasks (type, payload, dedupe_key, priority, run_at, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, JSON.stringify(payload ?? {}), o.dedupeKey ?? null, o.priority ?? 0, runAt, o.maxAttempts ?? 5, this.now()],
    ).lastInsertRowid
  }

  /** Claims the next due task whose type `accept` allows. */
  claim(accept: (type: string) => boolean): TaskRow | null {
    const candidates = this.db.all<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'pending' AND run_at <= ? ORDER BY priority DESC, run_at ASC LIMIT 50`,
      [this.now()],
    )
    for (const t of candidates) {
      if (!accept(t.type)) continue
      const r = this.db.run(
        "UPDATE tasks SET status = 'running', locked_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [this.now(), t.id],
      )
      if (r.changes === 1) return { ...t, status: 'running', attempts: t.attempts + 1, locked_at: this.now() }
    }
    return null
  }

  complete(id: number): void {
    this.db.run("UPDATE tasks SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ?", [this.now(), id])
  }

  /** Returns true when the task will be retried. */
  fail(id: number, error: string, permanent = false): boolean {
    const t = this.db.get<{ attempts: number; max_attempts: number }>('SELECT attempts, max_attempts FROM tasks WHERE id = ?', [id])
    if (!t) return false
    if (permanent || t.attempts >= t.max_attempts) {
      this.db.run("UPDATE tasks SET status = 'failed', finished_at = ?, last_error = ? WHERE id = ?", [this.now(), error, id])
      return false
    }
    this.db.run("UPDATE tasks SET status = 'pending', run_at = ?, last_error = ?, locked_at = NULL WHERE id = ?", [
      this.now() + backoffMs(t.attempts),
      error,
      id,
    ])
    return true
  }

  /** Puts a running task back for later without counting the attempt. */
  defer(id: number, runAt: number, reason: string): void {
    this.db.run("UPDATE tasks SET status = 'pending', run_at = ?, attempts = MAX(0, attempts - 1), locked_at = NULL, last_error = ? WHERE id = ?", [runAt, reason, id])
  }

  /** On startup: anything still marked running was interrupted by a crash or quit. */
  recover(): number {
    return this.db.run("UPDATE tasks SET status = 'pending', locked_at = NULL WHERE status = 'running'").changes
  }

  cancel(where: { type?: string; dedupeKey?: string }): number {
    if (where.dedupeKey) {
      return this.db.run("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE dedupe_key = ? AND status = 'pending'", [
        this.now(),
        where.dedupeKey,
      ]).changes
    }
    return this.db.run("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE type = ? AND status = 'pending'", [
      this.now(),
      where.type ?? '',
    ]).changes
  }

  prune(): void {
    const day = 86_400_000
    this.db.run("DELETE FROM tasks WHERE status IN ('done', 'cancelled') AND finished_at < ?", [this.now() - 7 * day])
    this.db.run("DELETE FROM tasks WHERE status = 'failed' AND finished_at < ?", [this.now() - 30 * day])
  }

  counts(): Record<TaskStatus, number> {
    const out: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 }
    for (const r of this.db.all<{ status: TaskStatus; n: number }>('SELECT status, COUNT(*) n FROM tasks GROUP BY status')) out[r.status] = r.n
    return out
  }
}
