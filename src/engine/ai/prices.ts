import type { PriceRow } from '../../shared/api/ai'
import type { Db } from '../core/db'

/**
 * Published list prices in USD per million tokens, collected 2026-09-27 from provider pricing pages
 * (via benchlm.ai and cloudzero.com summaries). Keys are normalized model ids (see normalizeModelId).
 * Users can override any price in Settings, and OpenRouter prices come live from its API.
 */
export const PRICES_AS_OF = '2026-09-27'
const BUNDLED: Record<string, Record<string, [number, number]>> = {
  anthropic: {
    'claude-fable-5-1': [10, 50],
    'claude-opus-5-5': [4, 20],
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [2, 10],
    'claude-haiku-4-5': [1, 5],
  },
  openai: {
    'gpt-6-astra': [10, 50],
    'gpt-6-sol': [2, 10],
    'gpt-6-luna': [0.1, 0.5],
    'gpt-5-6-sol': [4, 20],
    'gpt-5-6-terra': [2, 12],
    'gpt-5-6-luna': [0.2, 1.2],
    'gpt-5-5': [5, 30],
    'gpt-5-4': [2.5, 15],
    'gpt-5-4-mini': [0.75, 4.5],
    'gpt-5-4-nano': [0.2, 1.25],
    'gpt-5-2': [1.75, 14],
    'gpt-5-1': [1.25, 10],
    'gpt-5': [1.25, 10],
    'gpt-5-mini': [0.25, 2],
    'gpt-5-nano': [0.05, 0.4],
    'gpt-4-1': [2, 8],
    'gpt-4-1-mini': [0.4, 1.6],
    'gpt-4-1-nano': [0.1, 0.4],
    'gpt-4o': [2.5, 10],
    'gpt-4o-mini': [0.15, 0.6],
    o3: [2, 8],
    'o4-mini': [1.1, 4.4],
  },
  google: {
    'gemini-3-1-pro': [2, 12],
    'gemini-3-pro': [2, 12],
    'gemini-3-8-flash': [0.75, 3.75],
    'gemini-3-7-flash': [0.75, 3.75],
    'gemini-3-6-flash': [0.75, 3.75],
    'gemini-3-5-flash': [1.5, 9],
    'gemini-3-5-flash-lite': [0.3, 2.5],
    'gemini-3-1-flash-lite': [0.25, 1.5],
    'gemini-3-flash': [0.5, 3],
    'gemini-2-5-pro': [1.25, 10],
    'gemini-2-5-flash': [0.3, 2.5],
    'gemini-2-5-flash-lite': [0.1, 0.4],
  },
}
// Vertex serves the same Gemini models at the same list prices.
BUNDLED['vertex'] = BUNDLED['google']!

/** "models/gemini-2.5-flash-preview-05-20" -> "gemini-2-5-flash"; "claude-haiku-4-5-20251001" -> "claude-haiku-4-5". */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^[a-z0-9-]+\//, '') // openrouter-style "vendor/model"
    .replace(/[._:]/g, '-')
    .replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '')
    .replace(/-(latest|preview(-\d{2}-\d{2})?|exp(-\d+)?)$/, '')
}

export type Price = { input: number; output: number; source: PriceRow['source'] }

export class PriceBook {
  /** Filled from provider APIs that publish prices (OpenRouter). */
  private readonly live = new Map<string, Price>()

  constructor(private readonly db: Db) {}

  setLive(providerKind: string, modelId: string, input: number, output: number): void {
    this.live.set(`${providerKind}|${modelId}`, { input, output, source: 'provider' })
  }

  get(providerKind: string, modelId: string): Price | null {
    const user = this.db.get<{ input_per_m: number; output_per_m: number }>(
      'SELECT input_per_m, output_per_m FROM model_prices WHERE provider_kind = ? AND model_id = ?',
      [providerKind, modelId],
    )
    if (user) return { input: user.input_per_m, output: user.output_per_m, source: 'user' }
    const live = this.live.get(`${providerKind}|${modelId}`)
    if (live) return live
    if (providerKind === 'ollama' || providerKind === 'lmstudio' || providerKind === 'mock') return { input: 0, output: 0, source: 'bundled' }
    const bundled = BUNDLED[providerKind]?.[normalizeModelId(modelId)]
    return bundled ? { input: bundled[0], output: bundled[1], source: 'bundled' } : null
  }

  setUser(providerKind: string, modelId: string, input: number, output: number): void {
    this.db.run(
      `INSERT INTO model_prices (provider_kind, model_id, input_per_m, output_per_m) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_kind, model_id) DO UPDATE SET input_per_m = excluded.input_per_m, output_per_m = excluded.output_per_m`,
      [providerKind, modelId, input, output],
    )
  }

  /** Cost in USD, or null when the price is unknown. */
  cost(providerKind: string, modelId: string, inputTokens: number | undefined, outputTokens: number | undefined): number | null {
    const p = this.get(providerKind, modelId)
    if (!p) return null
    return ((inputTokens ?? 0) * p.input + (outputTokens ?? 0) * p.output) / 1_000_000
  }

  list(): PriceRow[] {
    const rows: PriceRow[] = []
    for (const [kind, table] of Object.entries(BUNDLED)) {
      if (kind === 'vertex') continue
      for (const [model, [input, output]] of Object.entries(table)) rows.push({ providerKind: kind, modelId: model, input, output, source: 'bundled' })
    }
    for (const r of this.db.all<{ provider_kind: string; model_id: string; input_per_m: number; output_per_m: number }>('SELECT * FROM model_prices')) {
      rows.push({ providerKind: r.provider_kind, modelId: r.model_id, input: r.input_per_m, output: r.output_per_m, source: 'user' })
    }
    return rows
  }
}
