import { Output, generateText, tool } from 'ai'
import { z } from 'zod'
import { ROLES, type RoleAssignment, type TestResult, type UsageSummary } from '../../shared/api/ai'
import { json } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { MOCK_SPEC, PROVIDER_SPECS, suggestModel } from './catalog'
import { spendSince, startOfDay, startOfMonth } from './ledger'
import type { PriceBook } from './prices'
import { definePrompt } from './prompt'
import type { Providers } from './providers'

const probe = definePrompt<null, { ok: boolean; capital: string }>({
  id: 'system.probe',
  version: 1,
  role: 'fast',
  system: 'You answer connection checks.',
  describe: 'A connection check result.',
  user: () => 'Reply with ok set to true and capital set to the capital city of France.',
  schema: z.object({ ok: z.boolean(), capital: z.string() }),
  maxOutputTokens: 200,
  mock: () => ({ ok: true, capital: 'Paris' }),
})

export function roleAssignments(ctx: Ctx, prices: PriceBook): RoleAssignment[] {
  return ROLES.map((role) => {
    const r = ctx.db.get<{ provider_id: number; model_id: string; label: string; kind: string }>(
      'SELECT m.provider_id, m.model_id, p.label, p.kind FROM model_roles m JOIN providers p ON p.id = m.provider_id WHERE m.role = ?',
      [role],
    )
    const price = r ? prices.get(r.kind, r.model_id) : null
    return {
      role,
      providerId: r?.provider_id ?? null,
      providerLabel: r?.label ?? null,
      modelId: r?.model_id ?? null,
      price: price ? { input: price.input, output: price.output } : null,
    }
  })
}

export function registerAiHandlers(ctx: Ctx, providers: Providers, prices: PriceBook): void {
  const { router, db } = ctx
  const changed = () => ctx.bus.changed('providers')

  router.on('ai.catalog', () => (ctx.demo ? [...PROVIDER_SPECS, MOCK_SPEC] : PROVIDER_SPECS))
  router.on('ai.providers', () => providers.rows().map((r) => providers.info(r)))

  router.on('ai.saveProvider', async (input) => {
    if (input.kind === 'mock' && !ctx.demo) throw new AppError('NOT_AVAILABLE', 'The offline demo model is only available in demo mode.', { permanent: true })
    const row = providers.save(input)
    changed()
    try {
      await providers.refreshModels(row.id)
    } catch (err) {
      // Saved, but the key or address may be wrong: report it without losing what was typed.
      ctx.log.warn('model list refresh failed after save', { kind: row.kind, err: errorMessage(err) })
      throw err
    } finally {
      changed()
    }
    return providers.info(providers.row(row.id))
  })

  router.on('ai.deleteProvider', ({ id }) => {
    providers.delete(id)
    changed()
    return null
  })

  router.on('ai.refreshModels', async ({ id }) => {
    await providers.refreshModels(id)
    changed()
    return providers.info(providers.row(id))
  })

  router.on('ai.test', async ({ providerId, modelId }): Promise<TestResult> => {
    const row = providers.row(providerId)
    if (row.kind === 'mock') return { ok: true, structured: true, tools: true, latencyMs: 0, error: null }
    const started = Date.now()
    const model = providers.model(providerId, modelId)
    let structured = false
    let tools = false
    let error: string | null = null
    try {
      const res = await generateText({
        model,
        prompt: probe.user(null),
        output: Output.object({ schema: probe.schema }),
        maxOutputTokens: 200,
        maxRetries: 1,
      })
      structured = probe.schema.safeParse(res.output).success
    } catch (err) {
      error = errorMessage(err)
    }
    try {
      const res = await generateText({
        model,
        prompt: 'Call the record tool with the word ready.',
        tools: { record: tool({ description: 'Records a word.', inputSchema: z.object({ word: z.string() }) }) },
        toolChoice: 'required',
        maxOutputTokens: 200,
        maxRetries: 1,
      })
      tools = res.toolCalls.length > 0
    } catch (err) {
      error ??= errorMessage(err)
    }
    providers.setCapability(providerId, modelId, { structured, tools })
    changed()
    const ok = structured || tools
    if (!ok && error && /401|403|api key|unauthorized|invalid.*key/i.test(error)) error = `${row.label} rejected the API key.`
    return { ok, structured, tools, latencyMs: Date.now() - started, error: ok ? null : error }
  })

  router.on('ai.roles', () => roleAssignments(ctx, prices))

  router.on('ai.setRole', ({ role, providerId, modelId }) => {
    providers.row(providerId)
    db.run('INSERT INTO model_roles (role, provider_id, model_id) VALUES (?, ?, ?) ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model_id = excluded.model_id', [
      role,
      providerId,
      modelId,
    ])
    changed()
    return roleAssignments(ctx, prices)
  })

  router.on('ai.autoAssign', ({ providerId, onlyEmpty }) => {
    const row = providers.row(providerId)
    const models = json.parse<string[]>(row.models, [])
    if (models.length === 0) throw new AppError('NO_MODELS', `${row.label} has no models listed yet. Refresh the model list first.`, { permanent: true })
    db.tx(() => {
      for (const role of ROLES) {
        if (onlyEmpty && db.get('SELECT 1 FROM model_roles WHERE role = ?', [role])) continue
        const modelId = suggestModel(row.kind, role, models)
        if (!modelId) continue
        db.run('INSERT INTO model_roles (role, provider_id, model_id) VALUES (?, ?, ?) ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model_id = excluded.model_id', [
          role,
          providerId,
          modelId,
        ])
      }
    })
    changed()
    return roleAssignments(ctx, prices)
  })

  router.on('ai.prices', () => prices.list())
  router.on('ai.setPrice', ({ providerKind, modelId, input, output }) => {
    prices.setUser(providerKind, modelId, input, output)
    changed()
    return null
  })

  router.on('ai.usage', ({ days }): UsageSummary => {
    const now = ctx.now()
    const since = startOfDay(now) - (days - 1) * 86_400_000
    const byDay = db
      .all<{ day: string; cost: number | null; calls: number; tokens: number | null }>(
        `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') day, SUM(cost) cost, COUNT(*) calls,
                SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) tokens
         FROM ai_ledger WHERE at >= ? GROUP BY day ORDER BY day`,
        [since],
      )
      .map((r) => ({ day: r.day, cost: r.cost ?? 0, calls: r.calls, tokens: r.tokens ?? 0 }))
    const byTask = db
      .all<{ task: string; cost: number | null; calls: number }>('SELECT task, SUM(cost) cost, COUNT(*) calls FROM ai_ledger WHERE at >= ? GROUP BY task ORDER BY cost DESC', [since])
      .map((r) => ({ task: r.task, cost: r.cost ?? 0, calls: r.calls }))
    return { today: spendSince(db, startOfDay(now)), month: spendSince(db, startOfMonth(now)), byDay, byTask }
  })

  router.on('ai.detectLocal', async () => {
    const tryList = async (url: string, pick: (j: unknown) => string[]) => {
      try {
        return pick(await ctx.http.getJson(url, { timeoutMs: 1500, retries: 0 }))
      } catch {
        return null
      }
    }
    const [ollama, lmstudio] = await Promise.all([
      tryList('http://127.0.0.1:11434/api/tags', (j) => ((j as { models?: { name: string }[] }).models ?? []).map((m) => m.name)),
      tryList('http://127.0.0.1:1234/v1/models', (j) => ((j as { data?: { id: string }[] }).data ?? []).map((m) => m.id)),
    ])
    return { ollama, lmstudio }
  })

}
