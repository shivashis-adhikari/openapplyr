import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../host'
import { testCtx } from '../test/harness'
import { authorize } from './oauth'

const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

/** Plays the browser: opens nothing, and returns to the loopback redirect with the given query. */
function browserThatReturns(query: (auth: URL) => Record<string, string>) {
  const opened: URL[] = []
  const host: HostClient = {
    async request(_method, params) {
      const auth = new URL((params as { url: string }).url)
      opened.push(auth)
      await realFetch(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams(query(auth))}`)
      return null as never
    },
  }
  return { host, opened }
}

const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`

describe('Microsoft sign-in', () => {
  it('uses PKCE on a loopback redirect and exchanges the code with the matching verifier', async () => {
    const ctx = testCtx()
    const { host, opened } = browserThatReturns((a) => ({ code: 'the-code', state: a.searchParams.get('state')! }))
    ctx.host = host
    let form: URLSearchParams | null = null
    vi.stubGlobal('fetch', async (url: string, init: { body: URLSearchParams }) => {
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
      form = new URLSearchParams(init.body)
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken({ preferred_username: 'ana@outlook.com' }) }))
    })
    const tokens = await authorize(ctx, { provider: 'microsoft', clientId: 'client-1' }, 'ana@outlook.com')

    const auth = opened[0]!
    expect(auth.origin + auth.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
    expect(auth.searchParams.get('login_hint')).toBe('ana@outlook.com')
    // The verifier sent with the code is the one the challenge was made from.
    const verifier = form!.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(auth.searchParams.get('code_challenge'))
    expect(form!.get('code')).toBe('the-code')
    expect(form!.get('redirect_uri')).toBe(auth.searchParams.get('redirect_uri'))
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', email: 'ana@outlook.com' })
  })

  it('rejects a redirect whose state does not match, without asking for tokens', async () => {
    const ctx = testCtx()
    ctx.host = browserThatReturns(() => ({ code: 'stolen', state: 'forged' })).host
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(authorize(ctx, { provider: 'microsoft', clientId: 'client-1' })).rejects.toThrow(/cancelled/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports the provider\'s reason when the user declines', async () => {
    const ctx = testCtx()
    ctx.host = browserThatReturns((a) => ({ error: 'access_denied', error_description: 'The user declined.', state: a.searchParams.get('state')! })).host
    await expect(authorize(ctx, { provider: 'microsoft', clientId: 'client-1' })).rejects.toThrow('The user declined.')
  })
})
