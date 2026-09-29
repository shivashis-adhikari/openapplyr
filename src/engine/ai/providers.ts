import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createCerebras } from '@ai-sdk/cerebras'
import { createCohere } from '@ai-sdk/cohere'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createFireworks } from '@ai-sdk/fireworks'
import { createGoogle } from '@ai-sdk/google'
import { createGoogleVertex } from '@ai-sdk/google-vertex'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createPerplexity } from '@ai-sdk/perplexity'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import type { FieldKey, ModelCapability, ProviderInfo, ProviderKind } from '../../shared/api/ai'
import { type Db, json } from '../core/db'
import { AppError } from '../core/errors'
import type { Http } from '../core/http'
import type { Secrets } from '../core/secrets'
import { chatModels, specFor } from './catalog'
import type { PriceBook } from './prices'
import { REPO_URL } from '../../shared/project'

export type ProviderRow = {
  id: number
  kind: ProviderKind
  label: string
  base_url: string | null
  config: string
  secret_id: number | null
  models: string
  capabilities: string
  created_at: number
}

export type ResolvedProvider = {
  row: ProviderRow
  config: Partial<Record<FieldKey, string>>
  secrets: Partial<Record<FieldKey, string>>
}

const DEFAULT_BASE: Partial<Record<ProviderKind, string>> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234/v1',
}

function parseHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function splitModels(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export class Providers {
  private readonly modelCache = new Map<string, LanguageModel>()

  constructor(
    private readonly db: Db,
    private readonly secrets: Secrets,
    private readonly http: Http,
    private readonly prices: PriceBook,
  ) {}

  rows(): ProviderRow[] {
    return this.db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at')
  }

  row(id: number): ProviderRow {
    const r = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id])
    if (!r) throw new AppError('NOT_FOUND', 'That model provider no longer exists.', { permanent: true })
    return r
  }

  resolve(id: number): ResolvedProvider {
    const row = this.row(id)
    const secretJson = this.secrets.get(row.secret_id)
    return {
      row,
      config: json.parse(row.config, {}),
      secrets: secretJson ? json.parse(secretJson, {}) : {},
    }
  }

  info(row: ProviderRow): ProviderInfo {
    const spec = specFor(row.kind)
    const secretJson = this.secrets.get(row.secret_id)
    const secrets = secretJson ? json.parse<Record<string, string>>(secretJson, {}) : {}
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      baseUrl: row.base_url,
      // The offline model has fixed names; it is never fetched.
      models: row.kind === 'mock' ? ['mock-large', 'mock-small'] : json.parse(row.models, []),
      capabilities: json.parse(row.capabilities, {}),
      configured: json.parse(row.config, {}),
      secretsSet: spec.fields.filter((f) => f.secret && secrets[f.key]).map((f) => f.key),
      createdAt: row.created_at,
    }
  }

  /** Creates or updates a provider. Blank secret fields on update keep the stored value. */
  save(input: { id?: number | undefined; kind: ProviderKind; label?: string | undefined; fields: Record<string, string> }): ProviderRow {
    const spec = specFor(input.kind)
    const existing = input.id ? this.resolve(input.id) : null
    if (existing && existing.row.kind !== input.kind) throw new AppError('KIND_CHANGE', 'Create a new provider to change its type.', { permanent: true })
    const config: Record<string, string> = {}
    const secrets: Record<string, string> = { ...(existing?.secrets as Record<string, string> | undefined) }
    for (const field of spec.fields) {
      const value = (input.fields[field.key] ?? '').trim()
      if (field.secret) {
        if (value) secrets[field.key] = value
      } else if (value) config[field.key] = value
      const have = field.secret ? secrets[field.key] : config[field.key]
      if (field.required && !have) throw new AppError('MISSING_FIELD', `Enter the ${field.label} for ${spec.label}.`, { permanent: true })
    }
    if (config['serviceAccountJson'] || secrets['serviceAccountJson']) {
      try {
        JSON.parse(secrets['serviceAccountJson'] ?? '')
      } catch {
        throw new AppError('BAD_JSON', 'The service account key is not valid JSON. Paste the whole file.', { permanent: true })
      }
    }
    const baseUrl = config['baseURL'] ?? DEFAULT_BASE[input.kind] ?? null
    if (baseUrl) {
      try {
        const u = new URL(baseUrl)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
      } catch {
        throw new AppError('BAD_URL', 'The base URL must start with http:// or https://.', { permanent: true })
      }
    }
    const label = input.label?.trim() || existing?.row.label || spec.label
    const manualModels = splitModels(config['models'])
    const now = Date.now()
    return this.db.tx(() => {
      let secretId = existing?.row.secret_id ?? null
      if (Object.keys(secrets).length) secretId = this.secrets.upsert(secretId, JSON.stringify(secrets))
      if (existing) {
        this.db.run('UPDATE providers SET label = ?, base_url = ?, config = ?, secret_id = ? WHERE id = ?', [label, baseUrl, JSON.stringify(config), secretId, existing.row.id])
        if (manualModels.length) this.db.run('UPDATE providers SET models = ? WHERE id = ?', [JSON.stringify(manualModels), existing.row.id])
        this.modelCache.clear()
        return this.row(existing.row.id)
      }
      const id = this.db.run(
        'INSERT INTO providers (kind, label, base_url, config, secret_id, models, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [input.kind, label, baseUrl, JSON.stringify(config), secretId, JSON.stringify(manualModels), now],
      ).lastInsertRowid
      return this.row(id)
    })
  }

  delete(id: number): void {
    const row = this.row(id)
    this.db.tx(() => {
      this.db.run('DELETE FROM providers WHERE id = ?', [id])
      this.secrets.delete(row.secret_id)
    })
    this.modelCache.clear()
  }

  setCapability(id: number, modelId: string, cap: Partial<ModelCapability>): void {
    const row = this.row(id)
    const caps = json.parse<Record<string, ModelCapability>>(row.capabilities, {})
    caps[modelId] = { structured: null, tools: null, ...caps[modelId], ...cap, checkedAt: Date.now() }
    this.db.run('UPDATE providers SET capabilities = ? WHERE id = ?', [JSON.stringify(caps), id])
  }

  capability(id: number, modelId: string): ModelCapability | null {
    return json.parse<Record<string, ModelCapability>>(this.row(id).capabilities, {})[modelId] ?? null
  }

  model(id: number, modelId: string): LanguageModel {
    const key = `${id}|${modelId}`
    let m = this.modelCache.get(key)
    if (!m) {
      m = this.build(this.resolve(id), modelId)
      this.modelCache.set(key, m)
    }
    return m
  }

  private build(p: ResolvedProvider, modelId: string): LanguageModel {
    const key = p.secrets.apiKey
    const base = p.row.base_url ?? undefined
    const headers = parseHeaders(p.config.headers)
    switch (p.row.kind) {
      case 'openai':
        return createOpenAI({ apiKey: key })(modelId)
      case 'anthropic':
        return createAnthropic({ apiKey: key })(modelId)
      case 'google':
        return createGoogle({ apiKey: key })(modelId)
      case 'vertex':
        return createGoogleVertex({
          project: p.config.project,
          location: p.config.location,
          googleAuthOptions: { credentials: JSON.parse(p.secrets.serviceAccountJson ?? '{}') },
        })(modelId)
      case 'azure':
        return createAzure({ resourceName: p.config.resourceName, apiKey: key })(modelId)
      case 'bedrock':
        return createAmazonBedrock({ region: p.config.region, accessKeyId: p.config.accessKeyId, secretAccessKey: p.secrets.secretAccessKey })(modelId)
      case 'mistral':
        return createMistral({ apiKey: key })(modelId)
      case 'groq':
        return createGroq({ apiKey: key })(modelId)
      case 'xai':
        return createXai({ apiKey: key })(modelId)
      case 'deepseek':
        return createDeepSeek({ apiKey: key })(modelId)
      case 'cohere':
        return createCohere({ apiKey: key })(modelId)
      case 'together':
        return createTogetherAI({ apiKey: key })(modelId)
      case 'fireworks':
        return createFireworks({ apiKey: key })(modelId)
      case 'perplexity':
        return createPerplexity({ apiKey: key })(modelId)
      case 'cerebras':
        return createCerebras({ apiKey: key })(modelId)
      case 'openrouter':
        return createOpenRouter({ apiKey: key, headers: { 'X-Title': 'OpenApplyr', 'HTTP-Referer': REPO_URL } }).chat(modelId)
      case 'ollama':
        return createOllama({ baseURL: `${(base ?? DEFAULT_BASE.ollama!).replace(/\/$/, '')}/api` })(modelId)
      case 'lmstudio':
        return createOpenAICompatible({ name: 'lmstudio', baseURL: base ?? DEFAULT_BASE.lmstudio!, supportsStructuredOutputs: true })(modelId)
      case 'openai-compatible':
        return createOpenAICompatible({ name: 'custom', baseURL: base!, apiKey: key, headers, supportsStructuredOutputs: true })(modelId)
      case 'anthropic-compatible':
        return createAnthropic({ baseURL: base, apiKey: key ?? 'none', headers })(modelId)
      case 'mock':
        throw new Error('The mock provider is handled by the AI service.')
    }
  }

  /** Asks the provider which models this key can use and stores the list. */
  async refreshModels(id: number): Promise<string[]> {
    const p = this.resolve(id)
    const spec = specFor(p.row.kind)
    let ids: string[] = []
    const manual = splitModels(p.config.models)
    if (!spec.listsModels) ids = p.row.kind === 'perplexity' && manual.length === 0 ? ['sonar', 'sonar-pro'] : manual
    else if (p.row.kind === 'mock') ids = ['mock-small', 'mock-large']
    else ids = await this.fetchModelIds(p)
    const list = [...new Set([...chatModels(ids), ...manual])]
    if (list.length === 0) throw new AppError('NO_MODELS', `${p.row.label} did not report any chat models for this key.`, { permanent: true })
    this.db.run('UPDATE providers SET models = ? WHERE id = ?', [JSON.stringify(list), id])
    return list
  }

  private async fetchModelIds(p: ResolvedProvider): Promise<string[]> {
    const key = p.secrets.apiKey ?? ''
    const bearer = { Authorization: `Bearer ${key}` }
    const get = <T>(url: string, headers: Record<string, string> = {}) => this.http.getJson<T>(url, { headers, timeoutMs: 20_000, retries: 1 })
    type Data = { data: { id: string }[] }
    try {
      switch (p.row.kind) {
        case 'openai':
          return (await get<Data>('https://api.openai.com/v1/models', bearer)).data.map((m) => m.id)
        case 'anthropic': {
          const out: string[] = []
          let after: string | undefined
          for (let page = 0; page < 5; page++) {
            const r = await get<{ data: { id: string }[]; has_more: boolean; last_id: string }>(
              `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${after}` : ''}`,
              { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            )
            out.push(...r.data.map((m) => m.id))
            if (!r.has_more) break
            after = r.last_id
          }
          return out
        }
        case 'google': {
          const r = await get<{ models: { name: string; supportedGenerationMethods?: string[] }[] }>(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
          )
          return r.models.filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''))
        }
        case 'mistral':
          return (await get<Data>('https://api.mistral.ai/v1/models', bearer)).data.map((m) => m.id)
        case 'groq':
          return (await get<Data>('https://api.groq.com/openai/v1/models', bearer)).data.map((m) => m.id)
        case 'xai':
          return (await get<Data>('https://api.x.ai/v1/models', bearer)).data.map((m) => m.id)
        case 'deepseek':
          return (await get<Data>('https://api.deepseek.com/models', bearer)).data.map((m) => m.id)
        case 'cohere':
          return (await get<{ models: { name: string }[] }>('https://api.cohere.com/v1/models?endpoint=chat&page_size=1000', bearer)).models.map((m) => m.name)
        case 'together': {
          const r = await get<{ id: string; type?: string }[] | Data>('https://api.together.xyz/v1/models', bearer)
          const arr = Array.isArray(r) ? r : r.data
          return arr.filter((m) => !('type' in m) || m.type === 'chat' || m.type === undefined).map((m) => m.id)
        }
        case 'fireworks':
          return (await get<Data>('https://api.fireworks.ai/inference/v1/models', bearer)).data.map((m) => m.id)
        case 'cerebras':
          return (await get<Data>('https://api.cerebras.ai/v1/models', bearer)).data.map((m) => m.id)
        case 'openrouter': {
          const r = await get<{ data: { id: string; pricing?: { prompt?: string; completion?: string } }[] }>('https://openrouter.ai/api/v1/models', bearer)
          for (const m of r.data) {
            const pi = Number(m.pricing?.prompt)
            const po = Number(m.pricing?.completion)
            if (Number.isFinite(pi) && Number.isFinite(po)) this.prices.setLive('openrouter', m.id, pi * 1e6, po * 1e6)
          }
          return r.data.map((m) => m.id)
        }
        case 'ollama': {
          const base = (p.row.base_url ?? DEFAULT_BASE.ollama!).replace(/\/$/, '')
          return (await get<{ models: { name: string }[] }>(`${base}/api/tags`)).models.map((m) => m.name)
        }
        case 'lmstudio':
        case 'openai-compatible': {
          const base = (p.row.base_url ?? DEFAULT_BASE.lmstudio!).replace(/\/$/, '')
          return (await get<Data>(`${base}/models`, { ...(key ? bearer : {}), ...parseHeaders(p.config.headers) })).data.map((m) => m.id)
        }
        case 'anthropic-compatible': {
          const base = (p.row.base_url ?? '').replace(/\/$/, '')
          return (await get<Data>(`${base}/models`, { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...parseHeaders(p.config.headers) })).data.map((m) => m.id)
        }
        default:
          return []
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'HTTP_401' || err.code === 'HTTP_403')) {
        throw new AppError('AUTH', `${p.row.label} rejected the API key. Copy it again from ${specFor(p.row.kind).keyUrl ?? 'the provider'} and save.`, { permanent: true })
      }
      if (err instanceof AppError && err.code === 'NETWORK' && specFor(p.row.kind).local) {
        throw new AppError('LOCAL_DOWN', `${p.row.label} is not running at ${p.row.base_url ?? DEFAULT_BASE[p.row.kind]}. Start it and try again.`, { permanent: true })
      }
      throw err
    }
  }
}
