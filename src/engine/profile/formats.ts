import { type Profile, ProfileSchema } from '../../shared/domain'
import { csvObjects } from '../util/csv'
import { isPresent, newId, normalizeMonth } from '../util/text'
import { readZip } from '../util/zip'

const bullets = (items: string[]) => items.map((t) => t.trim()).filter(Boolean).map((text) => ({ id: newId('b'), text }))

/** Splits a free-text description (LinkedIn positions) into bullet lines. */
export function splitBullets(text: string): string[] {
  return text
    .split(/\r?\n|(?:^|\s)[•▪◦●·]\s+/)
    .map((l) => l.replace(/^\s*[-*•▪◦●·]\s*/, '').trim())
    .filter((l) => l.length > 2)
}

/** JSON Resume (jsonresume.org schema v1) to the fact bank. */
export function fromJsonResume(doc: unknown): Profile {
  const r = (doc ?? {}) as Record<string, unknown>
  const b = (r['basics'] ?? {}) as Record<string, unknown>
  const loc = (b['location'] ?? {}) as Record<string, string>
  const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const end = (v: unknown) => (isPresent(s(v)) ? null : normalizeMonth(s(v)) || s(v))
  return ProfileSchema.parse({
    basics: {
      name: s(b['name']),
      email: s(b['email']),
      phone: s(b['phone']),
      headline: s(b['label']),
      summary: s(b['summary']),
      location: { city: s(loc['city']), region: s(loc['region']), country: s(loc['countryCode']) },
      links: [
        ...(s(b['url']) ? [{ label: 'Website', url: s(b['url']) }] : []),
        ...arr<Record<string, string>>(b['profiles']).filter((p) => s(p['url'])).map((p) => ({ label: s(p['network']) || 'Profile', url: s(p['url']) })),
      ],
    },
    work: arr<Record<string, unknown>>(r['work']).map((w) => ({
      id: newId('w'),
      company: s(w['name']) || s(w['company']),
      title: s(w['position']),
      location: s(w['location']),
      start: normalizeMonth(s(w['startDate'])),
      end: end(w['endDate']),
      summary: s(w['summary']),
      bullets: bullets(arr<string>(w['highlights'])),
      skills: [],
    })),
    education: arr<Record<string, unknown>>(r['education']).map((e) => ({
      id: newId('e'),
      institution: s(e['institution']),
      degree: s(e['studyType']),
      field: s(e['area']),
      start: normalizeMonth(s(e['startDate'])),
      end: normalizeMonth(s(e['endDate'])),
      grade: s(e['score']),
      bullets: bullets(arr<string>(e['courses'])),
    })),
    projects: arr<Record<string, unknown>>(r['projects']).map((p) => ({
      id: newId('p'),
      name: s(p['name']),
      url: s(p['url']),
      description: s(p['description']),
      bullets: bullets(arr<string>(p['highlights'])),
      skills: arr<string>(p['keywords']),
    })),
    skills: arr<Record<string, unknown>>(r['skills']).flatMap((sk) => {
      const kw = arr<string>(sk['keywords'])
      return kw.length ? kw.map((k) => ({ name: k, category: s(sk['name']) })) : [{ name: s(sk['name']) }]
    }).filter((sk) => sk.name),
    certifications: arr<Record<string, unknown>>(r['certificates']).map((c) => ({ id: newId('c'), name: s(c['name']), issuer: s(c['issuer']), date: s(c['date']), url: s(c['url']) })),
    languages: arr<Record<string, unknown>>(r['languages']).map((l) => ({ name: s(l['language']), fluency: s(l['fluency']) })),
    awards: arr<Record<string, unknown>>(r['awards']).map((a) => ({ id: newId('a'), title: s(a['title']), awarder: s(a['awarder']), date: s(a['date']), summary: s(a['summary']) })),
  })
}

/**
 * LinkedIn "Get a copy of your data" export. Deterministic: no model involved. File and column names
 * follow LinkedIn's export as of 2026; unknown files are ignored.
 */
export function fromLinkedInZip(buf: Buffer): { profile: Profile; sourceText: string } {
  const files = new Map(readZip(buf, (n) => n.toLowerCase().endsWith('.csv')).map((e) => [e.name.split('/').pop()!.toLowerCase(), e.data.toString('utf8')]))
  const rows = (name: string, header: string) => csvObjects(files.get(name) ?? '', header)
  const p = rows('profile.csv', 'First Name')[0] ?? {}
  const emails = rows('email addresses.csv', 'Email Address')
  const phones = rows('phonenumbers.csv', 'Number')
  const positions = rows('positions.csv', 'Company Name')
  const education = rows('education.csv', 'School Name')
  const skills = rows('skills.csv', 'Name')
  const languages = rows('languages.csv', 'Name')
  const certs = rows('certifications.csv', 'Name')
  const projects = rows('projects.csv', 'Title')
  const honors = rows('honors.csv', 'Title')
  if (!positions.length && !p['First Name']) throw new Error('This ZIP does not look like a LinkedIn data export (no Profile.csv or Positions.csv).')
  const primaryEmail = emails.find((e) => /yes/i.test(e['Primary'] ?? '')) ?? emails[0]
  const websites = (p['Websites'] ?? '')
    .replace(/[[\]]/g, '')
    .split(',')
    .map((w) => w.replace(/^[A-Z]+:/, '').trim())
    .filter((w) => /^https?:\/\//.test(w))
  const profile = ProfileSchema.parse({
    basics: {
      name: [p['First Name'], p['Last Name']].filter(Boolean).join(' '),
      email: primaryEmail?.['Email Address'] ?? '',
      phone: phones[0]?.['Number'] ?? '',
      headline: p['Headline'] ?? '',
      summary: p['Summary'] ?? '',
      location: { city: '', region: '', country: '' },
      links: websites.map((url) => ({ label: 'Website', url })),
    },
    work: positions.map((w) => ({
      id: newId('w'),
      company: w['Company Name'] ?? '',
      title: w['Title'] ?? '',
      location: w['Location'] ?? '',
      start: normalizeMonth(w['Started On']),
      end: isPresent(w['Finished On']) ? null : normalizeMonth(w['Finished On']),
      summary: '',
      bullets: bullets(splitBullets(w['Description'] ?? '')),
      skills: [],
    })),
    education: education.map((e) => ({
      id: newId('e'),
      institution: e['School Name'] ?? '',
      degree: e['Degree Name'] ?? '',
      field: '',
      start: normalizeMonth(e['Start Date']),
      end: normalizeMonth(e['End Date']),
      grade: '',
      bullets: bullets(splitBullets(e['Notes'] ?? '')),
    })),
    projects: projects.map((pr) => ({ id: newId('p'), name: pr['Title'] ?? '', url: pr['Url'] ?? '', description: pr['Description'] ?? '', bullets: [], skills: [] })),
    skills: skills.map((s) => ({ name: s['Name'] ?? '' })).filter((s) => s.name),
    certifications: certs.map((c) => ({ id: newId('c'), name: c['Name'] ?? '', issuer: c['Authority'] ?? '', date: normalizeMonth(c['Started On']), url: c['Url'] ?? '' })),
    languages: languages.map((l) => ({ name: l['Name'] ?? '', fluency: l['Proficiency'] ?? '' })),
    awards: honors.map((h) => ({ id: newId('a'), title: h['Title'] ?? '', awarder: '', date: normalizeMonth(h['Issued On']), summary: h['Description'] ?? '' })),
  })
  const sourceText = [...files.entries()].map(([name, text]) => `# ${name}\n${text}`).join('\n\n')
  return { profile, sourceText }
}
