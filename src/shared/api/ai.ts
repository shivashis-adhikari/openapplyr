import { z } from 'zod'
import { proc } from './define'

export const PROVIDER_KINDS = [
  'openai',
  'anthropic',
  'google',
  'vertex',
  'azure',
  'bedrock',
  'mistral',
  'groq',
  'xai',
  'deepseek',
  'cohere',
  'together',
  'fireworks',
  'perplexity',
  'cerebras',
  'openrouter',
  'ollama',
  'lmstudio',
  'openai-compatible',
  'anthropic-compatible',
  'mock',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const ROLES = ['fast', 'writer', 'agent', 'review'] as const
export type Role = (typeof ROLES)[number]

export type FieldKey = 'apiKey' | 'baseURL' | 'resourceName' | 'region' | 'accessKeyId' | 'secretAccessKey' | 'project' | 'location' | 'serviceAccountJson' | 'headers' | 'models'

export type ProviderField = {
  key: FieldKey
  label: string
  secret: boolean
  required: boolean
  placeholder: string
  help: string
  multiline?: boolean
}

export type ProviderSpec = {
  kind: ProviderKind
  label: string
  local: boolean
  keyUrl: string | null
  privacyUrl: string | null
  fields: ProviderField[]
  listsModels: boolean
}

export type ModelCapability = { structured: boolean | null; tools: boolean | null; checkedAt: number }

export type ProviderInfo = {
  id: number
  kind: ProviderKind
  label: string
  baseUrl: string | null
  models: string[]
  capabilities: Record<string, ModelCapability>
  configured: Partial<Record<FieldKey, string>>
  secretsSet: FieldKey[]
  createdAt: number
}

export type RoleAssignment = {
  role: Role
  providerId: number | null
  providerLabel: string | null
  modelId: string | null
  price: { input: number; output: number } | null
}

export type TestResult = { ok: boolean; structured: boolean; tools: boolean; latencyMs: number; error: string | null }

export type PriceRow = { providerKind: string; modelId: string; input: number; output: number; source: 'bundled' | 'user' | 'provider' }

export type UsageSummary = {
  today: { cost: number; calls: number; unpriced: number }
  month: { cost: number; calls: number; unpriced: number }
  byDay: { day: string; cost: number; calls: number; tokens: number }[]
  byTask: { task: string; cost: number; calls: number }[]
}

const Id = z.object({ id: z.number().int() })

export const aiApi = {
  'ai.catalog': proc<ProviderSpec[]>()(z.void()),
  'ai.providers': proc<ProviderInfo[]>()(z.void()),
  'ai.saveProvider': proc<ProviderInfo>()(
    z.object({
      id: z.number().int().optional(),
      kind: z.enum(PROVIDER_KINDS),
      label: z.string().max(80).optional(),
      fields: z.record(z.string(), z.string().max(20_000)),
    }),
  ),
  'ai.deleteProvider': proc<null>()(Id),
  'ai.refreshModels': proc<ProviderInfo>()(Id),
  'ai.test': proc<TestResult>()(z.object({ providerId: z.number().int(), modelId: z.string().min(1) })),
  'ai.roles': proc<RoleAssignment[]>()(z.void()),
  'ai.setRole': proc<RoleAssignment[]>()(z.object({ role: z.enum(ROLES), providerId: z.number().int(), modelId: z.string().min(1) })),
  'ai.autoAssign': proc<RoleAssignment[]>()(z.object({ providerId: z.number().int(), onlyEmpty: z.boolean().default(false) })),
  'ai.prices': proc<PriceRow[]>()(z.void()),
  'ai.setPrice': proc<null>()(z.object({ providerKind: z.string(), modelId: z.string(), input: z.number().min(0), output: z.number().min(0) })),
  'ai.usage': proc<UsageSummary>()(z.object({ days: z.number().int().min(1).max(365).default(30) })),
  'ai.detectLocal': proc<{ ollama: string[] | null; lmstudio: string[] | null }>()(z.void()),
}
