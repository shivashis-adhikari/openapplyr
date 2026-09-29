/**
 * Recognizes applicant tracking systems from URLs. Used to route applications to the right adapter,
 * to add companies to the registry, and to import a job from a pasted link.
 */
export type AtsId =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'smartrecruiters'
  | 'recruitee'
  | 'workable'
  | 'icims'
  | 'bamboohr'
  | 'taleo'
  | 'successfactors'
  | 'personio'
  | 'teamtailor'
  | 'breezy'
  | 'jazzhr'
  | 'rippling'
  | 'linkedin'
  | 'indeed'
  | 'wellfound'

export type Detected = {
  ats: AtsId
  /** Source config for boards we can poll. */
  board: Record<string, string> | null
  jobId: string | null
}

export function detectAts(input: string): Detected | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  const q = u.searchParams

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io' || host === 'boards.eu.greenhouse.io') {
    if (parts[0] === 'embed') {
      const token = q.get('for')
      return token ? { ats: 'greenhouse', board: { token }, jobId: q.get('token') } : null
    }
    const token = parts[0]
    if (!token) return null
    const i = parts.indexOf('jobs')
    return { ats: 'greenhouse', board: { token }, jobId: i >= 0 ? (parts[i + 1] ?? null) : null }
  }
  if (host === 'boards-api.greenhouse.io') {
    const i = parts.indexOf('boards')
    const token = i >= 0 ? parts[i + 1] : undefined
    return token ? { ats: 'greenhouse', board: { token }, jobId: parts[parts.indexOf('jobs') + 1] ?? null } : null
  }
  if (q.get('gh_jid')) return { ats: 'greenhouse', board: null, jobId: q.get('gh_jid') }

  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const site = parts[0]
    return site ? { ats: 'lever', board: { site, ...(host.includes('.eu.') ? { eu: 'true' } : {}) }, jobId: parts[1] ?? null } : null
  }
  if (host === 'jobs.ashbyhq.com') {
    const board = parts[0]
    return board ? { ats: 'ashby', board: { board: decodeURIComponent(board) }, jobId: parts[1] ?? null } : null
  }
  let m = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host)
  if (m) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts.slice(1) : parts
    const site = rest[0]
    const jobIdx = rest.indexOf('job')
    return site ? { ats: 'workday', board: { host, tenant: m[1]!, site }, jobId: jobIdx >= 0 ? rest.slice(jobIdx).join('/') : null } : null
  }
  m = /^([a-z0-9-]+)\.(wd\d+)\.myworkdaysite\.com$/.exec(host)
  if (m) {
    const i = parts.indexOf('recruiting')
    const tenant = parts[i + 1]
    const site = parts[i + 2]
    return tenant && site ? { ats: 'workday', board: { host, tenant, site }, jobId: null } : null
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    const company = parts[0]
    const jobId = parts[1] ? /^(\d+)/.exec(parts[1])?.[1] ?? null : null
    return company ? { ats: 'smartrecruiters', board: { company }, jobId } : null
  }
  m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host)
  if (m) return { ats: 'recruitee', board: { company: m[1]! }, jobId: parts[0] === 'o' ? (parts[1] ?? null) : null }
  if (host === 'apply.workable.com') {
    const account = parts[0]
    return account && account !== 'api' ? { ats: 'workable', board: { account }, jobId: parts[1] === 'j' ? (parts[2] ?? null) : null } : null
  }
  m = /^([a-z0-9-]+)\.workable\.com$/.exec(host)
  if (m && m[1] !== 'www' && m[1] !== 'apply') return { ats: 'workable', board: { account: m[1]! }, jobId: parts[1] ?? null }
  if (/\.icims\.com$/.test(host)) return { ats: 'icims', board: null, jobId: parts[parts.indexOf('jobs') + 1] ?? null }
  if (/\.bamboohr\.com$/.test(host)) return { ats: 'bamboohr', board: null, jobId: parts.at(-1) ?? q.get('id') }
  if (/\.taleo\.net$/.test(host)) return { ats: 'taleo', board: null, jobId: q.get('job') }
  if (/successfactors\.(com|eu)$/.test(host) || /\.sapsf\.(com|eu)$/.test(host)) return { ats: 'successfactors', board: null, jobId: q.get('career_job_req_id') }
  if (/\.jobs\.personio\.(de|com)$/.test(host)) return { ats: 'personio', board: null, jobId: parts[1] ?? null }
  if (/\.teamtailor\.com$/.test(host)) return { ats: 'teamtailor', board: null, jobId: parts[1] ?? null }
  if (/\.breezy\.hr$/.test(host)) return { ats: 'breezy', board: null, jobId: parts[1] ?? null }
  if (/\.applytojob\.com$/.test(host)) return { ats: 'jazzhr', board: null, jobId: parts[2] ?? null }
  if (host === 'ats.rippling.com') return { ats: 'rippling', board: null, jobId: parts[2] ?? null }
  if (/(^|\.)linkedin\.com$/.test(host) && parts[0] === 'jobs') return { ats: 'linkedin', board: null, jobId: parts[2] ?? q.get('currentJobId') }
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return { ats: 'indeed', board: null, jobId: q.get('jk') ?? q.get('vjk') }
  if (host === 'wellfound.com' || host === 'angel.co') return { ats: 'wellfound', board: null, jobId: parts.at(-1) ?? null }
  return null
}

/** Stable key for a pollable board (the `sources.key` column). */
export function boardKey(ats: string, board: Record<string, string>): string {
  switch (ats) {
    case 'greenhouse':
      return board['token']!.toLowerCase()
    case 'lever':
      return `${board['site']!.toLowerCase()}${board['eu'] ? '@eu' : ''}`
    case 'ashby':
      return board['board']!.toLowerCase()
    case 'workday':
      return `${board['host']!.toLowerCase()}/${board['site']}`
    case 'smartrecruiters':
      return board['company']!
    case 'recruitee':
      return board['company']!.toLowerCase()
    case 'workable':
      return board['account']!.toLowerCase()
    default:
      return JSON.stringify(board)
  }
}

/** Hosts that belong to job platforms rather than the employer (so they are not taken as the company domain). */
export function isPlatformHost(host: string): boolean {
  return /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|recruitee\.com|workable\.com|icims\.com|bamboohr\.com|taleo\.net|successfactors\.|personio\.|teamtailor\.com|breezy\.hr|applytojob\.com|rippling\.com|linkedin\.com|indeed\.|remotive\.com|remoteok\.com|arbeitnow\.com|themuse\.com|himalayas\.app|ycombinator\.com|adzuna\.|usajobs\.gov|jooble\.org|reed\.co\.uk|wellfound\.com|glassdoor\.)/i.test(host)
}
