import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'

/**
 * OAuth 2.0 authorization code with PKCE through the system browser and a loopback redirect on
 * 127.0.0.1 (RFC 8252). No client secret for Microsoft public clients; Google desktop clients issue a
 * "secret" that is not confidential, which the user supplies with their own client ID.
 */
export type OAuthProvider = 'microsoft' | 'google'

const CONFIG: Record<OAuthProvider, { auth: string; token: string; scopes: string[] }> = {
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'email', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
  },
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://mail.google.com/'],
  },
}

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; email: string | null }
export type OAuthClient = { provider: OAuthProvider; clientId: string; clientSecret?: string | undefined }

const b64url = (b: Buffer) => b.toString('base64url')

/** The e-mail claim from an ID token. The token came straight from the provider over TLS, so it is not re-verified. */
function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string; preferred_username?: string }
    return claims.email ?? claims.preferred_username ?? null
  } catch {
    return null
  }
}

async function tokenRequest(c: OAuthClient, params: Record<string, string>): Promise<Tokens & { raw: Record<string, unknown> }> {
  const body = new URLSearchParams({ client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), ...params })
  const res = await fetch(CONFIG[c.provider].token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) })
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof raw['access_token'] !== 'string') {
    const reason = typeof raw['error_description'] === 'string' ? raw['error_description'].split('\n')[0] : `HTTP ${res.status}`
    throw new AppError('OAUTH', `Sign-in failed: ${reason}`, { permanent: res.status >= 400 && res.status < 500 })
  }
  return {
    accessToken: raw['access_token'] as string,
    refreshToken: (raw['refresh_token'] as string | undefined) ?? params['refresh_token'] ?? '',
    expiresAt: Date.now() + Number(raw['expires_in'] ?? 3600) * 1000,
    email: emailFromIdToken(raw['id_token'] as string | undefined),
    raw,
  }
}

/** Opens the provider's sign-in page and waits (up to 5 minutes) for the redirect back to this machine. */
export async function authorize(ctx: Ctx, c: OAuthClient, loginHint?: string): Promise<Tokens> {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  let finish: (v: { code: string } | { error: string }) => void = () => undefined
  const result = new Promise<{ code: string } | { error: string }>((r) => (finish = r))
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>OpenApplyr</title><body style="font:16px system-ui;margin:48px">${ok ? 'Signed in. You can close this tab and return to OpenApplyr.' : 'Sign-in did not complete. Return to OpenApplyr and try again.'}</body>`)
    finish(ok ? { code: u.searchParams.get('code')! } : { error: u.searchParams.get('error_description') ?? u.searchParams.get('error') ?? 'The sign-in was cancelled.' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
  const url = new URL(CONFIG[c.provider].auth)
  url.search = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: CONFIG[c.provider].scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(c.provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString()
  try {
    await ctx.host.request('openExternal', { url: url.toString() })
    const timeout = new Promise<{ error: string }>((r) => setTimeout(() => r({ error: 'The sign-in took longer than 5 minutes.' }), 5 * 60_000))
    const r = await Promise.race([result, timeout])
    if ('error' in r) throw new AppError('OAUTH', r.error, { permanent: true })
    return await tokenRequest(c, { grant_type: 'authorization_code', code: r.code, redirect_uri: redirect, code_verifier: verifier })
  } finally {
    server.close()
  }
}

export async function refresh(c: OAuthClient, refreshToken: string): Promise<Tokens> {
  return tokenRequest(c, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: CONFIG[c.provider].scopes.join(' ') })
}
