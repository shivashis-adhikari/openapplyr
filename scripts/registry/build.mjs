// Builds registry/companies.jsonl: company career boards on public ATS job-board APIs.
// 1) Harvest board slugs from the Common Crawl URL index. 2) Keep only boards whose public API lists jobs.
// Usage: node scripts/registry/build.mjs [--pages 4] [--concurrency 8] [--merge]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const PAGES = Number(arg('pages', '4'))
const CONCURRENCY = Number(arg('concurrency', '8'))
const MERGE = process.argv.includes('--merge')
const UA = { 'User-Agent': 'OpenApplyr registry builder (+https://github.com/shivashis-adhikari/openapplyr)' }

const PATTERNS = [
  { ats: 'greenhouse', url: 'boards.greenhouse.io/*', slug: (u) => /boards\.greenhouse\.io\/([a-z0-9_-]+)/i.exec(u)?.[1] },
  { ats: 'greenhouse', url: 'job-boards.greenhouse.io/*', slug: (u) => /job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i.exec(u)?.[1] },
  { ats: 'lever', url: 'jobs.lever.co/*', slug: (u) => /jobs\.lever\.co\/([a-z0-9_.-]+)/i.exec(u)?.[1] },
  { ats: 'ashby', url: 'jobs.ashbyhq.com/*', slug: (u) => /jobs\.ashbyhq\.com\/([^/?#]+)/i.exec(u)?.[1] },
  { ats: 'recruitee', url: '*.recruitee.com', slug: (u) => /\/\/([a-z0-9-]+)\.recruitee\.com/i.exec(u)?.[1] },
  { ats: 'workable', url: 'apply.workable.com/*', slug: (u) => /apply\.workable\.com\/([a-z0-9_-]+)/i.exec(u)?.[1] },
  { ats: 'smartrecruiters', url: 'jobs.smartrecruiters.com/*', slug: (u) => /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/.exec(u)?.[1] },
  {
    ats: 'workday',
    url: '*.myworkdayjobs.com',
    slug: (u) => {
      const m = /\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/.exec(u)
      return m && !['wday', 'job', 'jobs'].includes(m[3]) ? `${m[1]}.${m[2]}.myworkdayjobs.com|${m[1]}|${m[3]}` : undefined
    },
  },
]
const IGNORE = new Set(['embed', 'api', 'v1', 'jobs', 'www', 'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'j', 'careers'])

async function getText(url, init = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(90_000) })
      if (r.status === 503 || r.status === 429) {
        await new Promise((s) => setTimeout(s, 3000 * (attempt + 1)))
        continue
      }
      return { status: r.status, text: await r.text() }
    } catch {
      await new Promise((s) => setTimeout(s, 2000))
    }
  }
  return { status: 0, text: '' }
}

async function harvest() {
  const idx = JSON.parse((await getText('https://index.commoncrawl.org/collinfo.json')).text)[0].id
  const found = new Map() // key -> {ats, slug}
  for (const p of PATTERNS) {
    const meta = await getText(`https://index.commoncrawl.org/${idx}-index?url=${encodeURIComponent(p.url)}&output=json&showNumPages=true`)
    const pages = Math.min(PAGES, JSON.parse(meta.text || '{"pages":0}').pages ?? 0)
    // Spread samples across the index rather than taking only the first pages (which are alphabetical).
    const step = Math.max(1, Math.floor((JSON.parse(meta.text || '{"pages":1}').pages ?? 1) / Math.max(1, pages)))
    for (let i = 0; i < pages; i++) {
      const res = await getText(`https://index.commoncrawl.org/${idx}-index?url=${encodeURIComponent(p.url)}&output=json&fl=url&page=${i * step}`)
      for (const line of res.text.split('\n')) {
        if (!line) continue
        let url
        try {
          url = JSON.parse(line).url
        } catch {
          continue
        }
        const slug = p.slug(url)
        if (!slug || IGNORE.has(slug.toLowerCase())) continue
        found.set(`${p.ats}:${slug.toLowerCase()}`, { ats: p.ats, slug })
      }
      process.stderr.write(`\r${p.ats} page ${i + 1}/${pages} -> ${found.size} candidates   `)
    }
  }
  process.stderr.write('\n')
  return [...found.values()]
}

async function validate({ ats, slug }) {
  const json = async (url, init) => {
    const r = await getText(url, init)
    if (r.status !== 200) return null
    try {
      return JSON.parse(r.text)
    } catch {
      return null
    }
  }
  switch (ats) {
    case 'greenhouse': {
      const b = await json(`https://boards-api.greenhouse.io/v1/boards/${slug}`)
      if (!b) return null
      const j = await json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)
      return j?.jobs?.length ? { ats, board: { token: slug.toLowerCase() }, name: b.name || slug } : null
    }
    case 'lever': {
      const j = await json(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`)
      return Array.isArray(j) && j.length ? { ats, board: { site: slug.toLowerCase() } } : null
    }
    case 'ashby': {
      const j = await json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(decodeURIComponent(slug))}`)
      return j?.jobs?.length ? { ats, board: { board: decodeURIComponent(slug) } } : null
    }
    case 'recruitee': {
      const j = await json(`https://${slug}.recruitee.com/api/offers/`)
      return j?.offers?.length ? { ats, board: { company: slug.toLowerCase() }, name: j.offers[0].company_name } : null
    }
    case 'workable': {
      const a = await json(`https://apply.workable.com/api/v1/widget/accounts/${slug}`)
      return a?.jobs?.length ? { ats, board: { account: slug.toLowerCase() }, name: a.name } : null
    }
    case 'smartrecruiters': {
      const j = await json(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`)
      return j?.totalFound > 0 ? { ats, board: { company: slug }, name: j.content?.[0]?.company?.name } : null
    }
    case 'workday': {
      const [host, tenant, site] = slug.split('|')
      const j = await json(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      })
      return j?.total > 0 ? { ats, board: { host, tenant, site } } : null
    }
  }
  return null
}

const candidates = await harvest()
const existing = MERGE && existsSync('registry/companies.jsonl') ? readFileSync('registry/companies.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const keyOf = (e) => `${e.ats}:${JSON.stringify(e.board).toLowerCase()}`
const out = new Map(existing.map((e) => [keyOf(e), e]))
let done = 0
const queue = [...candidates]
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const v = await validate(c).catch(() => null)
      if (v) out.set(keyOf(v), v)
      if (++done % 25 === 0) process.stderr.write(`\rvalidated ${done}/${candidates.length}, kept ${out.size}   `)
    }
  }),
)
process.stderr.write('\n')
const lines = [...out.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))).map((e) => JSON.stringify(e))
writeFileSync('registry/companies.jsonl', `${lines.join('\n')}\n`)
console.log(`wrote ${lines.length} boards`)
