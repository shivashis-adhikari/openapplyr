import { z } from 'zod'
import { type Profile, ProfileSchema } from '../../shared/domain'
import { block, definePrompt, untrusted } from '../ai/prompt'
import { countryCode } from '../jobs/geo'
import { coverage, fold, isPresent, newId, normalizeMonth, words } from '../util/text'

/** Model-facing schema: every field required (strict structured-output modes need that), empty string when absent. */
const Extracted = z.object({
  basics: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    headline: z.string(),
    summary: z.string(),
    city: z.string(),
    region: z.string(),
    country: z.string().describe('ISO 3166-1 alpha-2 code, or empty'),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
  }),
  work: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      start: z.string().describe('YYYY-MM or YYYY'),
      end: z.string().describe('YYYY-MM, YYYY, or "present"'),
      summary: z.string(),
      bullets: z.array(z.string()),
      skills: z.array(z.string()),
    }),
  ),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), field: z.string(), start: z.string(), end: z.string(), grade: z.string(), bullets: z.array(z.string()) })),
  projects: z.array(z.object({ name: z.string(), url: z.string(), description: z.string(), bullets: z.array(z.string()), skills: z.array(z.string()) })),
  skills: z.array(z.string()),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string(), date: z.string() })),
  languages: z.array(z.object({ name: z.string(), fluency: z.string() })),
  awards: z.array(z.object({ title: z.string(), awarder: z.string(), date: z.string(), summary: z.string() })),
})
export type Extracted = z.infer<typeof Extracted>

export const extractProfilePrompt = definePrompt<{ text: string }, Extracted>({
  id: 'profile.extract',
  version: 1,
  role: 'writer',
  system:
    'You convert a resume into structured data for a job-search tool. The data will be used to fill real job applications, ' +
    'so accuracy matters more than completeness: an invented detail could become a false statement on an application.',
  describe: 'The resume as structured data.',
  maxOutputTokens: 8000,
  user: ({ text }) =>
    [
      untrusted('resume', text),
      block(
        'instructions',
        [
          'Extract everything in the resume above into the output fields.',
          '- Copy text exactly as written: same wording, same numbers. Do not summarize, polish or merge bullets.',
          '- One entry per role. If one company lists several titles with separate dates, make one entry per title.',
          '- Dates as YYYY-MM when a month is given, YYYY when only a year is given. Use "present" for current roles.',
          '- skills: only skills the resume lists or names explicitly. Do not infer skills from job titles.',
          '- work[].skills: technologies and tools named in that role\'s text.',
          '- country: ISO two-letter code only when the resume states or clearly implies the country; otherwise empty.',
          '- Leave a field empty (or an empty list) when the resume does not contain it.',
        ].join('\n'),
      ),
    ].join('\n\n'),
  schema: Extracted,
  mock: ({ text }) => heuristicResume(text),
})

/** Country as an ISO code. "Lisbon, Portugal" puts the country where a region would be, so a region that names a country moves over. */
function place(city: string, region: string, country: string): { city: string; region: string; country: string } {
  const code = /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : countryCode(country)
  if (code) return { city, region, country: code }
  const regionIsCountry = region.trim().length > 3 ? countryCode(region) : null
  return regionIsCountry ? { city, region: '', country: regionIsCountry } : { city, region, country: '' }
}

/** Assigns stable ids and normalizes dates. */
export function toProfile(x: Extracted): Profile {
  const b = (items: string[]) => items.map((t) => t.trim()).filter(Boolean).map((text) => ({ id: newId('b'), text }))
  return ProfileSchema.parse({
    basics: {
      name: x.basics.name,
      email: x.basics.email,
      phone: x.basics.phone,
      headline: x.basics.headline,
      summary: x.basics.summary,
      location: place(x.basics.city, x.basics.region, x.basics.country),
      links: x.basics.links.filter((l) => l.url),
    },
    work: x.work.map((w) => ({
      id: newId('w'),
      company: w.company,
      title: w.title,
      location: w.location,
      start: normalizeMonth(w.start),
      end: isPresent(w.end) ? null : normalizeMonth(w.end),
      summary: w.summary,
      bullets: b(w.bullets),
      skills: w.skills,
    })),
    education: x.education.map((e) => ({ id: newId('e'), ...e, start: normalizeMonth(e.start), end: normalizeMonth(e.end), bullets: b(e.bullets) })),
    projects: x.projects.map((p) => ({ id: newId('p'), ...p, bullets: b(p.bullets) })),
    skills: [...new Map(x.skills.filter(Boolean).map((s) => [fold(s), { name: s.trim() }])).values()],
    certifications: x.certifications.map((c) => ({ id: newId('c'), ...c, url: '' })),
    languages: x.languages,
    awards: x.awards.map((a) => ({ id: newId('a'), ...a })),
  })
}

/** Every extracted string should be traceable to the source; anything that is not is shown to the user. */
export function unverifiedStrings(p: Profile, source: string): { path: string; text: string }[] {
  const src = fold(source)
  const srcWords = new Set(words(source))
  const out: { path: string; text: string }[] = []
  const exact = (path: string, text: string) => {
    if (text && !src.includes(fold(text))) out.push({ path, text })
  }
  const fuzzy = (path: string, text: string) => {
    if (text && coverage(text, srcWords) < 0.85) out.push({ path, text })
  }
  exact('basics.name', p.basics.name)
  exact('basics.email', p.basics.email)
  p.work.forEach((w, i) => {
    exact(`work.${i}.company`, w.company)
    exact(`work.${i}.title`, w.title)
    w.bullets.forEach((bl, j) => fuzzy(`work.${i}.bullets.${j}`, bl.text))
  })
  p.education.forEach((e, i) => exact(`education.${i}.institution`, e.institution))
  p.projects.forEach((pr, i) => pr.bullets.forEach((bl, j) => fuzzy(`projects.${i}.bullets.${j}`, bl.text)))
  p.skills.forEach((s, i) => exact(`skills.${i}`, s.name))
  return out
}

// ---------------------------------------------------------------------------
// Heuristic parser used by the offline demo model. Handles common single-column layouts.

const SECTION = /^(summary|profile|about|experience|work experience|professional experience|employment( history)?|education|skills|technical skills|core skills|projects|certifications|licenses|languages|awards|honors)\s*:?$/i
const RANGE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}-\d{2}|\d{4})\s*(?:[-–—]|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}-\d{2}|\d{4}|present|current|now)/i
const ROLE_WORDS = /\b(engineer|developer|manager|designer|analyst|lead|director|scientist|intern|consultant|specialist|architect|coordinator|associate|officer|head|vp|president|administrator|writer|editor|teacher|nurse|accountant|researcher|technician|representative|assistant|owner|founder|programmer|strategist|marketer|recruiter)\b/i

export function heuristicResume(text: string): Extracted {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const nonEmpty = lines.filter(Boolean)
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0] ?? ''
  const phone = /\+?\d[\d\s().-]{7,}\d/.exec(text)?.[0]?.trim() ?? ''
  const links = [...text.matchAll(/(https?:\/\/[^\s)]+|(?:www\.)?linkedin\.com\/in\/[^\s)]+|github\.com\/[^\s)]+)/gi)].map((m) => {
    const url = m[0].startsWith('http') ? m[0] : `https://${m[0]}`
    return { label: /linkedin/i.test(url) ? 'LinkedIn' : /github/i.test(url) ? 'GitHub' : 'Website', url }
  })
  const name = nonEmpty.find((l) => !l.includes('@') && !/\d/.test(l) && l.split(/\s+/).length <= 5 && !SECTION.test(l)) ?? ''

  const sections = new Map<string, string[]>()
  let current = 'header'
  for (const l of lines) {
    const m = SECTION.exec(l)
    if (m) {
      const k = m[1]!.toLowerCase()
      current = /experience|employment/.test(k) ? 'experience' : /skill/.test(k) ? 'skills' : /summary|profile|about/.test(k) ? 'summary' : /cert|licen/.test(k) ? 'certifications' : /award|honor/.test(k) ? 'awards' : k
      continue
    }
    if (!sections.has(current)) sections.set(current, [])
    sections.get(current)!.push(l)
  }
  const header = (sections.get('header') ?? []).filter(Boolean)
  const headline = header.find((l) => l !== name && !l.includes('@') && ROLE_WORDS.test(l) && !RANGE.test(l)) ?? ''
  const locLine = header.find((l) => /^[A-Z][a-zA-Z .'-]+,\s*[A-Z][a-zA-Z .'-]+$/.test(l)) ?? ''

  const work: Extracted['work'] = []
  const exp = sections.get('experience') ?? []
  for (let i = 0; i < exp.length; i++) {
    const l = exp[i]!
    const r = RANGE.exec(l)
    if (!r) {
      const last = work[work.length - 1]
      if (last && l) {
        const bullet = l.replace(/^[-*•▪◦●·]\s*/, '')
        if (/^[-*•▪◦●·]/.test(l) || last.bullets.length) last.bullets.push(bullet)
        else if (!last.company) last.company = bullet
      }
      continue
    }
    let head = l.slice(0, r.index).replace(/[\s,|·—–-]+$/, '').trim()
    if (!head && i > 0) head = exp[i - 1] ?? ''
    const parts = head.split(/\s+[—–|-]\s+|,\s+|\s+at\s+/).map((s) => s.trim()).filter(Boolean)
    let title = parts[0] ?? ''
    let company = parts[1] ?? ''
    if (company && ROLE_WORDS.test(company) && !ROLE_WORDS.test(title)) [title, company] = [company, title]
    const location = l.slice(r.index + r[0].length).replace(/^[\s,|·—–-]+/, '').trim()
    work.push({ company, title, location, start: normalizeMonth(r[1]!), end: isPresent(r[2]!) ? 'present' : normalizeMonth(r[2]!), summary: '', bullets: [], skills: [] })
  }

  const education: Extracted['education'] = []
  for (const l of (sections.get('education') ?? []).filter(Boolean)) {
    const r = RANGE.exec(l) ?? /(\d{4})/.exec(l)
    if (/(university|college|school|institute|academy)/i.test(l)) {
      const [institution = '', degree = ''] = l.replace(RANGE, '').split(/\s+[—–|-]\s+|,\s+/).map((s) => s.trim())
      education.push({ institution, degree, field: '', start: r && r[2] ? normalizeMonth(r[1]!) : '', end: r ? normalizeMonth(r[2] ?? r[1]!) : '', grade: '', bullets: [] })
    } else if (education.length && /(bachelor|master|b\.?s|m\.?s|phd|mba|diploma|degree)/i.test(l)) {
      education[education.length - 1]!.degree ||= l
    }
  }

  const skills = (sections.get('skills') ?? [])
    .join(', ')
    .replace(/^[^:]{0,30}:\s*/gm, '')
    .split(/[,;|•]/)
    .map((s) => s.replace(/^[^:]{1,30}:\s*/, '').trim())
    .filter((s) => s.length > 0 && s.length < 40)

  return {
    basics: { name, email, phone, headline, summary: (sections.get('summary') ?? []).filter(Boolean).join(' '), city: locLine.split(',')[0]?.trim() ?? '', region: locLine.split(',')[1]?.trim() ?? '', country: '', links },
    work,
    education,
    projects: [],
    skills: [...new Set(skills)],
    certifications: (sections.get('certifications') ?? []).filter(Boolean).map((l) => ({ name: l.replace(/^[-*•]\s*/, ''), issuer: '', date: '' })),
    languages: [],
    awards: [],
  }
}
