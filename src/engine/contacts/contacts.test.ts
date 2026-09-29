import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Http, type HttpRequest, HttpError } from '../core/http'
import { apollo, enrichers, hasMx, hunter, prospeo, snov } from './enrich'

type Call = { url: string; method: string; headers: Record<string, string>; json: unknown }

/** An Http that records each request and answers from the first route whose pattern matches. */
function recorder(routes: [RegExp, unknown | ((call: Call) => unknown)][]) {
  const calls: Call[] = []
  const http = {
    async getJson(url: string, req: HttpRequest = {}) {
      const call = { url, method: req.method ?? 'GET', headers: req.headers ?? {}, json: req.json }
      calls.push(call)
      const hit = routes.find(([re]) => re.test(url))
      if (!hit) throw new HttpError(404, url, 'no route')
      const v = typeof hit[1] === 'function' ? (hit[1] as (c: Call) => unknown)(call) : hit[1]
      if (v instanceof Error) throw v
      return structuredClone(v)
    },
  } as unknown as Http
  return { http, calls }
}

afterEach(() => vi.useRealTimers())

describe('contact lookups', () => {
  it('Hunter: searches a domain with the key header and keeps named people only', async () => {
    const { http, calls } = recorder([
      [
        /domain-search/,
        {
          data: {
            emails: [
              { value: 'ana.silva@acme.pt', type: 'personal', confidence: 94, first_name: 'Ana', last_name: 'Silva', position: 'Engineering Manager', linkedin: null, verification: { status: 'valid' } },
              { value: 'jobs@acme.pt', type: 'generic', confidence: 80, first_name: null, last_name: null, position: null, linkedin: null },
            ],
          },
        },
      ],
    ])
    const people = await hunter(http, 'hk').searchPeople('acme.pt', ['Engineering Manager'])
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.hunter\.io\/v2\/domain-search\?domain=acme\.pt&/)
    expect(calls[0]!.headers).toEqual({ 'X-API-KEY': 'hk' })
    expect(people).toEqual([{ name: 'Ana Silva', title: 'Engineering Manager', email: 'ana.silva@acme.pt', emailStatus: 'verified', linkedinUrl: null, source: 'hunter', confidence: 0.94 }])
  })

  it('Hunter: finds one address, and returns nothing when Hunter has none', async () => {
    const { http, calls } = recorder([[/email-finder/, (c: Call) => ({ data: c.url.includes('first_name=Ana') ? { email: 'ana@acme.pt', score: 71, position: null, verification: { status: 'accept_all' } } : { email: null, score: 0, position: null } })]])
    const h = hunter(http, 'hk')
    expect(await h.findEmail('Ana', 'Silva', 'acme.pt')).toMatchObject({ email: 'ana@acme.pt', emailStatus: 'likely', confidence: 0.71 })
    expect(calls[0]!.url).toBe('https://api.hunter.io/v2/email-finder?domain=acme.pt&first_name=Ana&last_name=Silva')
    expect(await h.findEmail('Rui', 'Costa', 'acme.pt')).toBeNull()
  })

  it('Apollo: searches by domain and title, then reveals at most three people', async () => {
    const people = [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, first_name: `Person${i}`, last_name_obfuscated: 'S***', title: 'Engineering Manager' }))
    const { http, calls } = recorder([
      [/mixed_people\/api_search/, { people }],
      [/people\/match/, (c: Call) => ({ person: { id: (c.json as { id: string }).id, first_name: 'Ana', last_name: 'Silva', title: 'Engineering Manager', email: 'ana@acme.pt', email_status: 'verified' } })],
    ])
    const out = await apollo(http, 'ak').searchPeople('acme.pt', ['Engineering Manager'])
    expect(calls[0]).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'ak' }, json: { q_organization_domains_list: ['acme.pt'], person_titles: ['Engineering Manager'] } })
    expect(calls.filter((c) => c.url.endsWith('/people/match'))).toHaveLength(3)
    expect(out[0]).toMatchObject({ email: 'ana@acme.pt', emailStatus: 'verified', source: 'apollo' })
  })

  it('Snov: gets a token, starts a task and polls until the result is ready', async () => {
    vi.useFakeTimers()
    let polls = 0
    const { http, calls } = recorder([
      [/oauth\/access_token/, { access_token: 'tok', expires_in: 3600 }],
      [/emails-by-domain-by-name\/start/, { data: { task_hash: 'h1' } }],
      [/emails-by-domain-by-name\/result/, () => (++polls < 2 ? { status: 'in_progress' } : { status: 'completed', data: [{ people: 'Ana Silva', result: [{ email: 'ana@acme.pt', smtp_status: 'valid' }] }] })],
    ])
    const found = snov(http, 'id', 'secret').findEmail('Ana', 'Silva', 'acme.pt')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await found).toMatchObject({ email: 'ana@acme.pt', emailStatus: 'verified', source: 'snov' })
    expect(calls[0]).toMatchObject({ method: 'POST', json: { grant_type: 'client_credentials', client_id: 'id', client_secret: 'secret' } })
    expect(calls[1]).toMatchObject({ headers: { Authorization: 'Bearer tok' }, json: { rows: [{ first_name: 'Ana', last_name: 'Silva', domain: 'acme.pt' }] } })
    expect(calls.at(-1)!.url).toBe('https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=h1')
  })

  it('Prospeo: asks for verified emails only and ignores masked or missing ones', async () => {
    const answers = [
      { error: false, person: { full_name: 'Ana Silva', current_job_title: 'Engineering Manager', email: { email: 'ana@acme.pt', status: 'VERIFIED' } } },
      { error: false, person: { email: { email: 'a***@acme.pt', status: 'VERIFIED' } } },
      new HttpError(400, 'x', 'NO_MATCH'),
    ]
    const { http, calls } = recorder([[/enrich-person/, () => answers.shift()]])
    const p = prospeo(http, 'pk')
    expect(await p.findEmail('Ana', 'Silva', 'acme.pt')).toMatchObject({ email: 'ana@acme.pt', emailStatus: 'verified', title: 'Engineering Manager' })
    expect(calls[0]).toMatchObject({ method: 'POST', headers: { 'X-KEY': 'pk' }, json: { data: { first_name: 'Ana', last_name: 'Silva', company_website: 'acme.pt' }, only_verified_email: true } })
    expect(await p.findEmail('Ana', 'Silva', 'acme.pt')).toBeNull()
    expect(await p.findEmail('Rui', 'Costa', 'acme.pt')).toBeNull()
  })

  it('uses only the services the user added keys for, in a fixed order', () => {
    const { http } = recorder([])
    expect(enrichers(http, {}).map((e) => e.id)).toEqual([])
    expect(enrichers(http, { prospeoKey: 'p', hunterKey: 'h', snovClientId: 'i' }).map((e) => e.id)).toEqual(['hunter', 'prospeo'])
    expect(enrichers(http, { apolloKey: 'a', snovClientId: 'i', snovClientSecret: 's' }).map((e) => e.id)).toEqual(['apollo', 'snov'])
  })

  it('treats a domain that cannot receive mail as having no MX', async () => {
    expect(await hasMx('no-such-host.invalid')).toBe(false)
  })
})
