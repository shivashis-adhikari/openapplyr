// Records small, real responses from each public job source into fixtures/sources/*.json.
// Adapters are tested against these, and the weekly canary compares live responses with them.
// Usage: node scripts/fixtures/record-sources.mjs [kind...]
import { writeFileSync } from 'node:fs'

const UA = { 'User-Agent': 'OpenApplyr fixture recorder (+https://github.com/shivashis-adhikari/openapplyr)', Accept: 'application/json' }
const get = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}
const clip = (s, n = 2500) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}` : s)
const save = (kind, data) => {
  writeFileSync(`fixtures/sources/${kind}.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...data }, null, 1)}\n`)
  console.log('recorded', kind)
}

const recorders = {
  async greenhouse() {
    const list = await get('https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true')
    list.jobs = list.jobs.slice(0, 3).map((j) => ({ ...j, content: clip(j.content) }))
    const q = await get(`https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${list.jobs[0].id}?questions=true&pay_transparency=true`)
    q.content = clip(q.content)
    const board = await get('https://boards-api.greenhouse.io/v1/boards/stripe')
    save('greenhouse', { token: 'stripe', board, list, questions: q })
  },
  async lever() {
    const list = (await get('https://api.lever.co/v0/postings/palantir?mode=json')).slice(0, 3)
    for (const j of list) {
      j.description = clip(j.description)
      j.descriptionPlain = clip(j.descriptionPlain)
      j.additional = clip(j.additional)
      j.additionalPlain = clip(j.additionalPlain)
      j.lists = (j.lists ?? []).map((l) => ({ ...l, content: clip(l.content, 800) }))
    }
    save('lever', { site: 'palantir', list })
  },
  async ashby() {
    const d = await get('https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true')
    d.jobs = d.jobs.slice(0, 3).map((j) => ({ ...j, descriptionHtml: clip(j.descriptionHtml), descriptionPlain: clip(j.descriptionPlain) }))
    save('ashby', { board: 'openai', list: d })
  },
  async workday() {
    const base = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite'
    const list = await get(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 3, offset: 0, searchText: '' }) })
    const detail = await get(`${base}${list.jobPostings[0].externalPath}`)
    detail.jobPostingInfo.jobDescription = clip(detail.jobPostingInfo.jobDescription)
    delete detail.similarJobs
    save('workday', { host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite', list, detail })
  },
  async smartrecruiters() {
    const list = await get('https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=3')
    const detail = await get(`https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/${list.content[0].id}`)
    for (const s of Object.values(detail.jobAd?.sections ?? {})) if (s && typeof s === 'object') s.text = clip(s.text, 1500)
    save('smartrecruiters', { company: 'ServiceNow', list, detail })
  },
  async recruitee() {
    const d = await get('https://bunq.recruitee.com/api/offers/')
    d.offers = d.offers.slice(0, 3).map((o) => ({ ...o, description: clip(o.description), requirements: clip(o.requirements, 1500), translations: undefined }))
    save('recruitee', { company: 'bunq', list: d })
  },
  async workable() {
    const list = await get('https://apply.workable.com/api/v3/accounts/huggingface/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    list.results = list.results.slice(0, 3)
    const detail = await get(`https://apply.workable.com/api/v2/accounts/huggingface/jobs/${list.results[0].shortcode}`)
    for (const k of ['description', 'requirements', 'benefits']) detail[k] = clip(detail[k], 1500)
    const account = await get('https://apply.workable.com/api/v1/widget/accounts/huggingface')
    save('workable', { account: 'huggingface', name: account.name, list, detail })
  },
  async remotive() {
    const d = await get('https://remotive.com/api/remote-jobs?limit=3')
    d.jobs = d.jobs.slice(0, 3).map((j) => ({ ...j, description: clip(j.description) }))
    save('remotive', { list: d })
  },
  async remoteok() {
    const d = await get('https://remoteok.com/api')
    save('remoteok', { list: [d[0], ...d.slice(1, 4).map((j) => ({ ...j, description: clip(j.description) }))] })
  },
  async arbeitnow() {
    const d = await get('https://www.arbeitnow.com/api/job-board-api')
    d.data = d.data.slice(0, 3).map((j) => ({ ...j, description: clip(j.description) }))
    save('arbeitnow', { list: d })
  },
  async themuse() {
    const d = await get('https://www.themuse.com/api/public/jobs?page=1&descending=true')
    d.results = d.results.slice(0, 3).map((j) => ({ ...j, contents: clip(j.contents) }))
    save('themuse', { list: d })
  },
  async himalayas() {
    const d = await get('https://himalayas.app/jobs/api?limit=3')
    d.jobs = d.jobs.slice(0, 3).map((j) => ({ ...j, description: clip(j.description) }))
    save('himalayas', { list: d })
  },
  async hn() {
    const search = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=3')
    const story = search.hits.find((h) => /who is hiring/i.test(h.title))
    const item = await get(`https://hn.algolia.com/api/v1/items/${story.objectID}`)
    item.children = item.children.filter((c) => c.text).slice(0, 5).map((c) => ({ id: c.id, created_at_i: c.created_at_i, author: c.author, text: clip(c.text, 2000), children: [] }))
    save('hn', { search: { hits: [story] }, item })
  },
}

const wanted = process.argv.slice(2)
for (const [kind, fn] of Object.entries(recorders)) {
  if (wanted.length && !wanted.includes(kind)) continue
  try {
    await fn()
  } catch (err) {
    console.error(`FAILED ${kind}: ${err.message}`)
    process.exitCode = 1
  }
}
