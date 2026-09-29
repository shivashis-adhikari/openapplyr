import type { Db } from '../core/db'

export function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfMonth(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

/** Spend since a time. Calls to models without a known price are counted, not guessed. */
export function spendSince(db: Db, since: number): { cost: number; unpriced: number; calls: number } {
  const r = db.get<{ cost: number | null; unpriced: number; calls: number }>(
    'SELECT SUM(cost) cost, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced, COUNT(*) calls FROM ai_ledger WHERE at >= ?',
    [since],
  )!
  return { cost: r.cost ?? 0, unpriced: r.unpriced ?? 0, calls: r.calls ?? 0 }
}

export type LedgerEntry = {
  providerId: number | null
  providerKind: string
  modelId: string
  role: string
  task: string
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  cost: number | null
  ok: boolean
  error?: string
}

export function record(db: Db, e: LedgerEntry, at = Date.now()): void {
  db.run(
    `INSERT INTO ai_ledger (at, provider_id, provider_kind, model_id, role, task, input_tokens, output_tokens, cached_tokens, cost, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [at, e.providerId, e.providerKind, e.modelId, e.role, e.task, e.inputTokens, e.outputTokens, e.cachedTokens, e.cost, e.ok, e.error ?? null],
  )
}
