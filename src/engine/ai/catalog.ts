import type { FieldKey, ProviderField, ProviderKind, ProviderSpec, Role } from '../../shared/api/ai'

const f = (key: FieldKey, label: string, o: Partial<ProviderField> = {}): ProviderField => ({
  key,
  label,
  secret: false,
  required: false,
  placeholder: '',
  help: '',
  ...o,
})
const apiKey = (placeholder: string, help = '') => f('apiKey', 'API key', { secret: true, required: true, placeholder, help })
const baseURL = (placeholder: string, required = false, help = '') => f('baseURL', 'Base URL', { placeholder, required, help })
const models = (help: string) =>
  f('models', 'Model names', { placeholder: 'One per line', help, multiline: true })

export const PROVIDER_SPECS: ProviderSpec[] = [
  { kind: 'openai', label: 'OpenAI', local: false, keyUrl: 'https://platform.openai.com/api-keys', privacyUrl: 'https://openai.com/enterprise-privacy/', fields: [apiKey('sk-...')], listsModels: true },
  { kind: 'anthropic', label: 'Anthropic', local: false, keyUrl: 'https://console.anthropic.com/settings/keys', privacyUrl: 'https://www.anthropic.com/legal/commercial-terms', fields: [apiKey('sk-ant-...')], listsModels: true },
  { kind: 'google', label: 'Google Gemini', local: false, keyUrl: 'https://aistudio.google.com/app/apikey', privacyUrl: 'https://ai.google.dev/gemini-api/terms', fields: [apiKey('AIza...')], listsModels: true },
  {
    kind: 'vertex',
    label: 'Google Vertex AI',
    local: false,
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    privacyUrl: 'https://cloud.google.com/terms/service-terms',
    fields: [
      f('project', 'Project ID', { required: true, placeholder: 'my-project' }),
      f('location', 'Location', { required: true, placeholder: 'us-central1' }),
      f('serviceAccountJson', 'Service account key (JSON)', { secret: true, required: true, multiline: true, placeholder: '{ "type": "service_account", ... }' }),
      models('Model names as Vertex lists them, for example gemini-2.5-flash.'),
    ],
    listsModels: false,
  },
  {
    kind: 'azure',
    label: 'Azure OpenAI',
    local: false,
    keyUrl: 'https://portal.azure.com/',
    privacyUrl: 'https://learn.microsoft.com/legal/cognitive-services/openai/data-privacy',
    fields: [
      f('resourceName', 'Resource name', { required: true, placeholder: 'my-resource' }),
      apiKey('Key from the resource page'),
      models('Your deployment names. Azure calls models by deployment.'),
    ],
    listsModels: false,
  },
  {
    kind: 'bedrock',
    label: 'Amazon Bedrock',
    local: false,
    keyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    privacyUrl: 'https://aws.amazon.com/bedrock/security-compliance/',
    fields: [
      f('region', 'Region', { required: true, placeholder: 'us-east-1' }),
      f('accessKeyId', 'Access key ID', { required: true, placeholder: 'AKIA...' }),
      f('secretAccessKey', 'Secret access key', { secret: true, required: true }),
      models('Model IDs or inference profile IDs enabled in your account.'),
    ],
    listsModels: false,
  },
  { kind: 'mistral', label: 'Mistral', local: false, keyUrl: 'https://console.mistral.ai/api-keys', privacyUrl: 'https://mistral.ai/terms', fields: [apiKey('')], listsModels: true },
  { kind: 'groq', label: 'Groq', local: false, keyUrl: 'https://console.groq.com/keys', privacyUrl: 'https://groq.com/privacy-policy/', fields: [apiKey('gsk_...')], listsModels: true },
  { kind: 'xai', label: 'xAI', local: false, keyUrl: 'https://console.x.ai/', privacyUrl: 'https://x.ai/legal/privacy-policy', fields: [apiKey('xai-...')], listsModels: true },
  { kind: 'deepseek', label: 'DeepSeek', local: false, keyUrl: 'https://platform.deepseek.com/api_keys', privacyUrl: 'https://platform.deepseek.com/downloads/DeepSeek%20Privacy%20Policy.html', fields: [apiKey('sk-...')], listsModels: true },
  { kind: 'cohere', label: 'Cohere', local: false, keyUrl: 'https://dashboard.cohere.com/api-keys', privacyUrl: 'https://cohere.com/privacy', fields: [apiKey('')], listsModels: true },
  { kind: 'together', label: 'Together AI', local: false, keyUrl: 'https://api.together.ai/settings/api-keys', privacyUrl: 'https://www.together.ai/privacy', fields: [apiKey('')], listsModels: true },
  { kind: 'fireworks', label: 'Fireworks', local: false, keyUrl: 'https://fireworks.ai/account/api-keys', privacyUrl: 'https://fireworks.ai/privacy-policy', fields: [apiKey('fw_...')], listsModels: true },
  {
    kind: 'perplexity',
    label: 'Perplexity',
    local: false,
    keyUrl: 'https://www.perplexity.ai/settings/api',
    privacyUrl: 'https://www.perplexity.ai/hub/legal/privacy-policy',
    fields: [apiKey('pplx-...'), models('Perplexity has no model list endpoint. Leave empty to use sonar and sonar-pro.')],
    listsModels: false,
  },
  { kind: 'cerebras', label: 'Cerebras', local: false, keyUrl: 'https://cloud.cerebras.ai/', privacyUrl: 'https://www.cerebras.ai/privacy-policy', fields: [apiKey('csk-...')], listsModels: true },
  { kind: 'openrouter', label: 'OpenRouter', local: false, keyUrl: 'https://openrouter.ai/keys', privacyUrl: 'https://openrouter.ai/privacy', fields: [apiKey('sk-or-...')], listsModels: true },
  {
    kind: 'ollama',
    label: 'Ollama (on this computer)',
    local: true,
    keyUrl: null,
    privacyUrl: null,
    fields: [baseURL('http://127.0.0.1:11434', false, 'Leave empty for the default address.')],
    listsModels: true,
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio (on this computer)',
    local: true,
    keyUrl: null,
    privacyUrl: null,
    fields: [baseURL('http://127.0.0.1:1234/v1', false, 'Start the local server in LM Studio first.')],
    listsModels: true,
  },
  {
    kind: 'openai-compatible',
    label: 'Custom (OpenAI-compatible)',
    local: false,
    keyUrl: null,
    privacyUrl: null,
    fields: [
      baseURL('https://api.example.com/v1', true, 'The address that ends before /chat/completions.'),
      f('apiKey', 'API key', { secret: true, placeholder: 'Optional' }),
      f('headers', 'Extra headers', { multiline: true, placeholder: 'Header-Name: value', help: 'One per line.' }),
      models('Optional. Used when the endpoint has no /models list.'),
    ],
    listsModels: true,
  },
  {
    kind: 'anthropic-compatible',
    label: 'Custom (Anthropic-compatible)',
    local: false,
    keyUrl: null,
    privacyUrl: null,
    fields: [
      baseURL('https://api.example.com/v1', true, 'The address that ends before /messages.'),
      f('apiKey', 'API key', { secret: true, placeholder: 'Optional' }),
      f('headers', 'Extra headers', { multiline: true, placeholder: 'Header-Name: value', help: 'One per line.' }),
      models('Optional. Used when the endpoint has no /models list.'),
    ],
    listsModels: true,
  },
]

export const MOCK_SPEC: ProviderSpec = {
  kind: 'mock',
  label: 'Offline demo model',
  local: true,
  keyUrl: null,
  privacyUrl: null,
  fields: [],
  listsModels: true,
}

export function specFor(kind: ProviderKind): ProviderSpec {
  if (kind === 'mock') return MOCK_SPEC
  const spec = PROVIDER_SPECS.find((s) => s.kind === kind)
  if (!spec) throw new Error(`Unknown provider kind ${kind}`)
  return spec
}

/**
 * Preferred model patterns per role, most preferred first. Defaults are picked from the provider's
 * live model list with these, so new model versions are chosen without an app update.
 */
const ROLE_PATTERNS: Partial<Record<ProviderKind, Record<Role, RegExp[]>>> = {
  openai: {
    fast: [/^gpt-6-luna/, /^gpt-5\.?6-luna/, /^gpt-5\.?4-mini/, /^gpt-5-mini/, /mini/],
    writer: [/^gpt-6-sol/, /^gpt-5\.?6-(sol|terra)/, /^gpt-5\.?5$/, /^gpt-5\.?4$/, /^gpt-5(\.\d)?$/, /^gpt-4\.?1$/],
    agent: [/^gpt-6-sol/, /^gpt-5\.?6-(sol|terra)/, /^gpt-5\.?5$/, /^gpt-5\.?4$/, /^gpt-5(\.\d)?$/, /^gpt-4\.?1$/],
    review: [/^gpt-6-sol/, /^gpt-5\.?6-(sol|terra)/, /^gpt-5\.?5$/, /^gpt-5(\.\d)?$/],
  },
  anthropic: {
    fast: [/haiku/],
    writer: [/sonnet-5/, /sonnet/],
    agent: [/sonnet-5/, /sonnet/, /opus/],
    review: [/sonnet-5/, /sonnet/],
  },
  google: {
    fast: [/gemini-3[.-]\d-flash-lite/, /flash-lite/, /gemini-3[.-]\d-flash$/, /flash/],
    writer: [/gemini-3[.-]\d-pro$/, /gemini-3[.-]\d-flash$/, /pro/, /flash/],
    agent: [/gemini-3[.-]\d-flash$/, /gemini-3[.-]\d-pro$/, /flash/, /pro/],
    review: [/gemini-3[.-]\d-pro$/, /pro/, /flash/],
  },
  mistral: {
    fast: [/mistral-small-latest/, /small/, /ministral/],
    writer: [/mistral-large-latest/, /mistral-medium-latest/, /large/, /medium/],
    agent: [/mistral-large-latest/, /mistral-medium-latest/, /large/, /medium/],
    review: [/mistral-large-latest/, /large/, /medium/],
  },
  groq: {
    fast: [/llama-3\.1-8b-instant/, /8b/, /gpt-oss-20b/],
    writer: [/gpt-oss-120b/, /70b/, /kimi/, /qwen/],
    agent: [/gpt-oss-120b/, /70b/, /kimi/],
    review: [/gpt-oss-120b/, /70b/],
  },
  xai: { fast: [/mini/, /fast/], writer: [/grok-4/, /grok/], agent: [/grok-4/, /grok/], review: [/grok-4/, /grok/] },
  deepseek: { fast: [/deepseek-chat/], writer: [/deepseek-chat/], agent: [/deepseek-chat/], review: [/deepseek-reasoner/, /deepseek-chat/] },
  cohere: { fast: [/command-r7b/, /command-a/], writer: [/command-a/, /command-r-plus/], agent: [/command-a/], review: [/command-a/] },
  openrouter: {
    fast: [/^anthropic\/claude-haiku/, /^google\/gemini-.*flash/, /^openai\/gpt-.*(mini|luna)/],
    writer: [/^anthropic\/claude-sonnet/, /^openai\/gpt-(6|5)/, /^google\/gemini-.*pro/],
    agent: [/^anthropic\/claude-sonnet/, /^openai\/gpt-(6|5)/, /^google\/gemini-.*(pro|flash)/],
    review: [/^anthropic\/claude-sonnet/, /^openai\/gpt-(6|5)/],
  },
  perplexity: { fast: [/^sonar$/], writer: [/sonar-pro/, /sonar/], agent: [/sonar-pro/], review: [/sonar-pro/] },
}

const NOT_CHAT = /(embed|embedding|tts|whisper|transcribe|dall-e|image|audio|realtime|moderation|search|rerank|guard|vision-preview|davinci|babbage|computer-use|sora|veo|imagen|aqa|learnlm)/i

export function chatModels(ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => !NOT_CHAT.test(id)).sort()
}

export function suggestModel(kind: ProviderKind, role: Role, available: string[]): string | null {
  const list = chatModels(available)
  if (list.length === 0) return null
  const patterns = ROLE_PATTERNS[kind]?.[role] ?? []
  for (const re of patterns) {
    // Prefer undated aliases, then the newest dated snapshot.
    const hits = list.filter((m) => re.test(m.replace(/^models\//, '')))
    if (hits.length) return hits.sort((a, b) => a.length - b.length || b.localeCompare(a))[0]!
  }
  return list[0]!
}
