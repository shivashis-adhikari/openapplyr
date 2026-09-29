import { createHash } from 'node:crypto'
import { APICallError, type LanguageModel, type ModelMessage, NoObjectGeneratedError, Output, RetryError, type ToolSet, generateText } from 'ai'
import { z } from 'zod'
import type { ProviderKind, Role } from '../../shared/api/ai'
import type { Db } from '../core/db'
import { AppError, errorMessage } from '../core/errors'
import type { Bus } from '../core/events'
import type { Logger } from '../core/log'
import type { SettingsStore } from '../core/settings'
import { record, spendSince, startOfDay, startOfMonth } from './ledger'
import type { PriceBook } from './prices'
import type { PromptDef } from './prompt'
import { UNTRUSTED_RULE } from './prompt'
import type { Providers } from './providers'

export type Assignment = { providerId: number; kind: ProviderKind; label: string; modelId: string }
/** Adds the cost of every call made with it; used to price one package or run. */
export type Meter = { cost: number }
export type CallOptions = { task: string; signal?: AbortSignal | undefined; meter?: Meter | undefined }
export type ToolCallOut = { toolCallId?: string; toolName: string; input: unknown }

const ROLE_FALLBACK: Record<Role, Role[]> = {
  fast: ['fast', 'writer', 'agent', 'review'],
  writer: ['writer', 'review', 'agent', 'fast'],
  agent: ['agent', 'writer', 'review', 'fast'],
  review: ['review', 'writer', 'agent', 'fast'],
}

/** Pulls the first JSON object or array out of model text (handles code fences and leading prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('No JSON found in the model response.')
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return JSON.parse(body.slice(start, i + 1))
  }
  throw new Error('The model response contained incomplete JSON.')
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('\n')
}

export class AiService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly log: Logger,
    private readonly bus: Bus,
    private readonly providers: Providers,
    private readonly prices: PriceBook,
    private readonly now: () => number = Date.now,
  ) {}

  assignment(role: Role): Assignment | null {
    for (const r of ROLE_FALLBACK[role]) {
      const row = this.db.get<{ provider_id: number; model_id: string; kind: ProviderKind; label: string }>(
        'SELECT m.provider_id, m.model_id, p.kind, p.label FROM model_roles m JOIN providers p ON p.id = m.provider_id WHERE m.role = ?',
        [r],
      )
      if (row) return { providerId: row.provider_id, kind: row.kind, label: row.label, modelId: row.model_id }
    }
    return null
  }

  require(role: Role): Assignment {
    const a = this.assignment(role)
    if (!a) throw new AppError('NO_MODEL', 'Connect a model provider in Settings, Models, then try again.', { permanent: true })
    return a
  }

  isMock(role: Role = 'fast'): boolean {
    return this.assignment(role)?.kind === 'mock'
  }

  private checkBudget(a: Assignment): void {
    const price = this.prices.get(a.kind, a.modelId)
    if (price && price.input === 0 && price.output === 0) return // local and demo models are free
    const b = this.settings.get().budget
    const now = this.now()
    if (spendSince(this.db, startOfDay(now)).cost >= b.daily) {
      throw new AppError('BUDGET', `Today's model budget of $${b.daily.toFixed(2)} is used up. Raise it in Settings, Models, or work resumes tomorrow.`)
    }
    if (spendSince(this.db, startOfMonth(now)).cost >= b.monthly) {
      throw new AppError('BUDGET', `This month's model budget of $${b.monthly.toFixed(2)} is used up. Raise it in Settings, Models.`)
    }
  }

  private ledger(a: Assignment, role: Role, o: { task: string; meter?: Meter | undefined }, usage: UsageLike | undefined, ok: boolean, error?: string): void {
    const input = usage?.inputTokens
    const output = usage?.outputTokens
    const cost = usage ? this.prices.cost(a.kind, a.modelId, input, output) : ok ? null : 0
    if (cost && o.meter) o.meter.cost += cost
    record(
      this.db,
      {
        providerId: a.providerId,
        providerKind: a.kind,
        modelId: a.modelId,
        role,
        task: o.task,
        inputTokens: input ?? null,
        outputTokens: output ?? null,
        cachedTokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
        cost,
        ok,
        ...(error ? { error } : {}),
      },
      this.now(),
    )
    this.bus.changed('usage')
  }

  private mapError(err: unknown, a: Assignment): AppError {
    let e = err
    if (RetryError.isInstance(e)) e = e.lastError
    if (e instanceof AppError) return e
    if (APICallError.isInstance(e)) {
      const status = e.statusCode ?? 0
      const body = (e.responseBody ?? '').toLowerCase()
      const who = `${a.label} (${a.modelId})`
      if (status === 401 || status === 403) return new AppError('AUTH', `${a.label} rejected the API key. Update it in Settings, Models.`, { permanent: true, detail: e.message })
      if (status === 404) return new AppError('MODEL_NOT_FOUND', `${a.label} has no model named "${a.modelId}". Pick another in Settings, Models.`, { permanent: true, detail: e.message })
      if (status === 402 || body.includes('insufficient_quota') || body.includes('credit balance') || body.includes('billing')) {
        return new AppError('QUOTA', `${a.label} says the account is out of credit. Add credit with the provider, then retry.`, { permanent: true, detail: e.message })
      }
      if (status === 429) return new AppError('RATE_LIMIT', `${who} is rate limiting requests. OpenApplyr will retry.`, { detail: e.message })
      if (status === 400 && /(context|too long|maximum.*tokens|token limit)/.test(body)) {
        return new AppError('CONTEXT', `The input was too long for ${who}. Choose a model with a larger context window.`, { permanent: true, detail: e.message })
      }
      if (status >= 500) return new AppError('PROVIDER_DOWN', `${who} returned ${status}. OpenApplyr will retry.`, { detail: e.message })
      return new AppError('AI_ERROR', `${who} returned an error (${status || 'no status'}).`, { detail: e.message, permanent: status >= 400 && status < 500 })
    }
    if (e instanceof Error && e.name === 'AbortError') return new AppError('ABORTED', 'Stopped.', { permanent: true })
    return new AppError('AI_ERROR', `${a.label} failed: ${errorMessage(e)}`, { detail: errorMessage(e) })
  }

  /**
   * Structured output with three layers of defense: native structured output where the provider has it,
   * a JSON-in-text fallback, and one repair turn that feeds validation errors back. Anything that still
   * fails validation throws; bad data never reaches the database.
   */
  async structured<I, O>(prompt: PromptDef<I, O>, input: I, opts: CallOptions): Promise<O> {
    const a = this.require(prompt.role)
    const task = `${prompt.id}@${prompt.version}`
    if (a.kind === 'mock') {
      const out = prompt.schema.parse(prompt.mock(input))
      this.ledger(a, prompt.role, opts, { inputTokens: 0, outputTokens: 0 }, true)
      return out
    }
    const user = prompt.user(input)
    const cacheKey = prompt.cache ? createHash('sha256').update(`${task}|${a.kind}|${a.modelId}|${user}`).digest('hex') : null
    if (cacheKey) {
      const hit = this.db.get<{ value: string }>('SELECT value FROM ai_cache WHERE key = ?', [cacheKey])
      if (hit) {
        const parsed = prompt.schema.safeParse(JSON.parse(hit.value))
        if (parsed.success) return parsed.data
      }
    }
    this.checkBudget(a)
    const model = this.providers.model(a.providerId, a.modelId)
    const system = `${prompt.system}\n\n${UNTRUSTED_RULE}`
    const cap = this.providers.capability(a.providerId, a.modelId)
    let result: O
    try {
      result = cap?.structured === false ? await this.viaJson(model, a, prompt, system, user, opts) : await this.viaNative(model, a, prompt, system, user, opts)
    } catch (err) {
      const mapped = this.mapError(err, a)
      this.ledger(a, prompt.role, opts, undefined, false, mapped.message)
      throw mapped
    }
    if (cacheKey) {
      this.db.run('INSERT OR REPLACE INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)', [cacheKey, JSON.stringify(result), this.now()])
    }
    return result
  }

  private async viaNative<I, O>(model: LanguageModel, a: Assignment, prompt: PromptDef<I, O>, system: string, user: string, opts: CallOptions): Promise<O> {
    let res: Awaited<ReturnType<typeof generateText>> | undefined
    try {
      res = await generateText({
        model,
        system,
        prompt: user,
        output: Output.object({ schema: prompt.schema, name: prompt.id.replace(/[^a-zA-Z0-9_]/g, '_'), description: prompt.describe }),
        maxOutputTokens: prompt.maxOutputTokens ?? 4096,
        ...(prompt.temperature !== undefined ? { temperature: prompt.temperature } : {}),
        maxRetries: 2,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      })
      const out = prompt.schema.parse(res.output)
      this.ledger(a, prompt.role, opts, res.totalUsage, true)
      if (this.providers.capability(a.providerId, a.modelId)?.structured !== true) this.providers.setCapability(a.providerId, a.modelId, { structured: true })
      return out
    } catch (err) {
      // Failed calls still cost tokens; record whatever usage the SDK reports.
      const usage = res?.totalUsage ?? (NoObjectGeneratedError.isInstance(err) ? err.usage : undefined)
      if (usage) this.ledger(a, prompt.role, opts, usage, false, 'invalid structured output')
      const unsupported = APICallError.isInstance(err) && err.statusCode === 400 && !/(context|too long)/i.test(err.responseBody ?? '')
      const invalid = !APICallError.isInstance(err) && !RetryError.isInstance(err) && !(err instanceof Error && err.name === 'AbortError')
      if (!unsupported && !invalid) throw err
      this.log.warn('structured output failed; using JSON fallback', { prompt: prompt.id, model: a.modelId, err: errorMessage(err) })
      const out = await this.viaJson(model, a, prompt, system, user, opts)
      if (unsupported) this.providers.setCapability(a.providerId, a.modelId, { structured: false })
      return out
    }
  }

  private async viaJson<I, O>(model: LanguageModel, a: Assignment, prompt: PromptDef<I, O>, system: string, user: string, opts: CallOptions): Promise<O> {
    const schemaJson = JSON.stringify(z.toJSONSchema(prompt.schema, { io: 'input', unrepresentable: 'any' }))
    const jsonSystem = `${system}\n\nReply with one JSON value that matches this JSON Schema. No prose before or after it, no code fences.\n${schemaJson}`
    const messages: ModelMessage[] = [{ role: 'user', content: user }]
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await generateText({
        model,
        system: jsonSystem,
        messages,
        maxOutputTokens: prompt.maxOutputTokens ?? 4096,
        maxRetries: 2,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      })
      let problem: string
      try {
        const parsed = prompt.schema.safeParse(extractJson(res.text))
        if (parsed.success) {
          this.ledger(a, prompt.role, opts, res.totalUsage, true)
          return parsed.data
        }
        problem = `The JSON did not match the schema:\n${issuesText(parsed.error)}`
      } catch (err) {
        problem = errorMessage(err)
      }
      this.ledger(a, prompt.role, opts, res.totalUsage, false, 'invalid JSON output')
      messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: `${problem}\nReturn the corrected JSON only.` })
    }
    throw new AppError('BAD_MODEL_OUTPUT', `${a.label} (${a.modelId}) did not return usable data after a retry. Try a stronger model for this task.`)
  }

  /** Free-form or tool-calling turn (assistant, mock interviews, the form agent). */
  async turn(opts: {
    role: Role
    task: string
    system: string
    messages: ModelMessage[]
    tools?: ToolSet
    toolChoice?: 'auto' | 'required'
    maxOutputTokens?: number
    signal?: AbortSignal | undefined
    meter?: Meter | undefined
    mock: () => { text: string; toolCalls?: ToolCallOut[] }
  }): Promise<{ text: string; toolCalls: ToolCallOut[] }> {
    const a = this.require(opts.role)
    if (a.kind === 'mock') {
      const out = opts.mock()
      this.ledger(a, opts.role, opts, { inputTokens: 0, outputTokens: 0 }, true)
      return { text: out.text, toolCalls: out.toolCalls ?? [] }
    }
    this.checkBudget(a)
    try {
      const res = await generateText({
        model: this.providers.model(a.providerId, a.modelId),
        system: `${opts.system}\n\n${UNTRUSTED_RULE}`,
        messages: opts.messages,
        ...(opts.tools ? { tools: opts.tools, toolChoice: opts.toolChoice ?? 'auto' } : {}),
        maxOutputTokens: opts.maxOutputTokens ?? 2048,
        maxRetries: 2,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      })
      this.ledger(a, opts.role, opts, res.totalUsage, true)
      if (opts.tools) this.providers.setCapability(a.providerId, a.modelId, { tools: true })
      return { text: res.text, toolCalls: res.toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) }
    } catch (err) {
      const mapped = this.mapError(err, a)
      this.ledger(a, opts.role, opts, undefined, false, mapped.message)
      throw mapped
    }
  }
}

type UsageLike = {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined
}
