import { z } from 'zod'
import { json } from './core/db'
import { AppError } from './core/errors'
import type { Ctx } from './engine'

/** Third-party services the user connects with their own keys. Secrets are encrypted; config is not secret. */
export const INTEGRATIONS = {
  adzuna: { label: 'Adzuna', fields: { adzunaAppId: false, adzunaAppKey: true }, url: 'https://developer.adzuna.com/' },
  usajobs: { label: 'USAJOBS', fields: { usajobsEmail: false, usajobsKey: true }, url: 'https://developer.usajobs.gov/apirequest/' },
  jooble: { label: 'Jooble', fields: { joobleKey: true }, url: 'https://jooble.org/api/about' },
  reed: { label: 'Reed', fields: { reedKey: true }, url: 'https://www.reed.co.uk/developers/jobseeker' },
  hunter: { label: 'Hunter', fields: { hunterKey: true }, url: 'https://hunter.io/api-keys' },
  apollo: { label: 'Apollo', fields: { apolloKey: true }, url: 'https://developer.apollo.io/keys/' },
  snov: { label: 'Snov.io', fields: { snovClientId: false, snovClientSecret: true }, url: 'https://app.snov.io/account/api' },
  prospeo: { label: 'Prospeo', fields: { prospeoKey: true }, url: 'https://app.prospeo.io/api' },
  ntfy: { label: 'ntfy (phone push)', fields: { ntfyTopicUrl: false, ntfyToken: true }, url: 'https://ntfy.sh/' },
} as const
export type IntegrationKind = keyof typeof INTEGRATIONS

export const IntegrationKindSchema = z.enum(Object.keys(INTEGRATIONS) as [IntegrationKind, ...IntegrationKind[]])

export type IntegrationInfo = { kind: IntegrationKind; label: string; url: string; connected: boolean; enabled: boolean; config: Record<string, string>; secretsSet: string[]; fields: { key: string; secret: boolean }[] }

export function listIntegrations(ctx: Ctx): IntegrationInfo[] {
  return (Object.keys(INTEGRATIONS) as IntegrationKind[]).map((kind) => {
    const spec = INTEGRATIONS[kind]
    const row = ctx.db.get<{ config: string; secret_id: number | null; enabled: number }>('SELECT config, secret_id, enabled FROM integrations WHERE kind = ?', [kind])
    const secrets = row?.secret_id ? json.parse<Record<string, string>>(ctx.secrets.get(row.secret_id), {}) : {}
    return {
      kind,
      label: spec.label,
      url: spec.url,
      connected: !!row,
      enabled: row ? !!row.enabled : false,
      config: json.parse(row?.config, {}),
      secretsSet: Object.keys(secrets).filter((k) => secrets[k]),
      fields: Object.entries(spec.fields).map(([key, secret]) => ({ key, secret })),
    }
  })
}

export function saveIntegration(ctx: Ctx, kind: IntegrationKind, values: Record<string, string>, enabled = true): void {
  const spec = INTEGRATIONS[kind]
  const row = ctx.db.get<{ id: number; secret_id: number | null }>('SELECT id, secret_id FROM integrations WHERE kind = ?', [kind])
  const oldSecrets = row?.secret_id ? json.parse<Record<string, string>>(ctx.secrets.get(row.secret_id), {}) : {}
  const config: Record<string, string> = {}
  const secrets: Record<string, string> = { ...oldSecrets }
  for (const [key, secret] of Object.entries(spec.fields)) {
    const v = (values[key] ?? '').trim()
    if (secret) {
      if (v) secrets[key] = v
    } else if (v) config[key] = v
    if (!(secret ? secrets[key] : config[key])) throw new AppError('MISSING_FIELD', `${spec.label} needs every field filled in.`, { permanent: true })
  }
  ctx.db.tx(() => {
    const secretId = ctx.secrets.upsert(row?.secret_id, JSON.stringify(secrets))
    if (row) ctx.db.run('UPDATE integrations SET config = ?, secret_id = ?, enabled = ? WHERE id = ?', [JSON.stringify(config), secretId, enabled, row.id])
    else ctx.db.run('INSERT INTO integrations (kind, config, secret_id, enabled, created_at) VALUES (?, ?, ?, ?, ?)', [kind, JSON.stringify(config), secretId, enabled, ctx.now()])
  })
}

export function deleteIntegration(ctx: Ctx, kind: IntegrationKind): void {
  const row = ctx.db.get<{ secret_id: number | null }>('SELECT secret_id FROM integrations WHERE kind = ?', [kind])
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM integrations WHERE kind = ?', [kind])
    ctx.secrets.delete(row?.secret_id)
  })
}

/** All connected credentials as one flat map (field keys are globally unique). */
export function credentials(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of ctx.db.all<{ config: string; secret_id: number | null; enabled: number }>('SELECT config, secret_id, enabled FROM integrations')) {
    if (!row.enabled) continue
    Object.assign(out, json.parse(row.config, {}), row.secret_id ? json.parse(ctx.secrets.get(row.secret_id), {}) : {})
  }
  return out
}
