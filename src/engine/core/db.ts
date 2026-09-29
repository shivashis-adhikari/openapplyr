import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

export type Params = Record<string, unknown> | unknown[]
export type RunResult = { changes: number; lastInsertRowid: number }

function norm(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  // node:sqlite binds every JS number as REAL, so 'job:' || 2 would read 'job:2.0'. Whole numbers bind as INTEGER.
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : v
  if (typeof v === 'string' || typeof v === 'bigint') return v
  if (v instanceof Uint8Array) return v
  if (v instanceof Date) return v.getTime()
  throw new TypeError(`Unsupported SQL parameter type: ${typeof v}`)
}

/**
 * node:sqlite takes positional values or one object of named values. Named values the statement does
 * not use are left out (node:sqlite rejects them), so callers can share one parameter object between
 * queries that use different subsets of it. (A name the object lacks binds as NULL.)
 */
function bind(sql: string, params?: Params): SQLInputValue[] {
  if (!params) return []
  if (Array.isArray(params)) return params.map(norm)
  const out: Record<string, SQLInputValue> = {}
  for (const [k, v] of Object.entries(params)) if (new RegExp(`[:@$]${k}\\b`).test(sql)) out[k] = norm(v)
  return [out as unknown as SQLInputValue]
}

/** Thin wrapper over node:sqlite with statement caching, parameter normalization and nested transactions. */
export class Db {
  readonly raw: DatabaseSync
  private readonly stmts = new Map<string, StatementSync>()
  private depth = 0

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)
  }

  migrate(): number {
    const current = (this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0) as number
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!)
        this.raw.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
    return MIGRATIONS.length
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  get<T>(sql: string, params?: Params): T | undefined {
    return this.stmt(sql).get(...bind(sql, params)) as T | undefined
  }

  all<T>(sql: string, params?: Params): T[] {
    return this.stmt(sql).all(...bind(sql, params)) as T[]
  }

  run(sql: string, params?: Params): RunResult {
    const r = this.stmt(sql).run(...bind(sql, params))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /** Runs fn atomically. Nested calls use savepoints, so an inner failure rolls back only its part. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0
    const sp = `sp${this.depth}`
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const result = fn()
      if (result instanceof Promise) throw new Error('Db.tx callbacks must be synchronous.')
      this.depth--
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`)
      return result
    } catch (err) {
      this.depth--
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw err
    }
  }

  close(): void {
    this.stmts.clear()
    if (this.raw.isOpen) this.raw.close()
  }
}

export const json = {
  parse<T>(text: string | null | undefined, fallback: T): T {
    if (text == null || text === '') return fallback
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  },
  str(value: unknown): string {
    return JSON.stringify(value ?? null)
  },
}
