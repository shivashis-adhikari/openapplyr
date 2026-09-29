import type { Profile } from '../../shared/domain'
import { countryName } from '../jobs/geo'
import { yearsOfExperience } from './store'

/**
 * The profile as the model sees it: every fact tagged with its id so outputs can cite evidence.
 * Contact details are left out unless asked for; they are not needed to judge fit or write bullets.
 */
export function profileDigest(p: Profile, o: { contact?: boolean; maxBullets?: number } = {}): string {
  const lines: string[] = []
  if (o.contact) {
    lines.push(`Name: ${p.basics.name}`)
    const loc = [p.basics.location.city, p.basics.location.region, p.basics.location.country].filter(Boolean).join(', ')
    if (loc) lines.push(`Location: ${loc}`)
  }
  if (p.basics.headline) lines.push(`Headline: ${p.basics.headline}`)
  if (p.basics.summary) lines.push(`Summary: ${p.basics.summary}`)
  lines.push(`Total experience: ${yearsOfExperience(p)} years`)
  if (p.skills.length) lines.push(`Skills: ${p.skills.map((s) => (s.years ? `${s.name} (${s.years}y)` : s.name)).join(', ')}`)
  lines.push('')
  for (const w of p.work) {
    lines.push(`[${w.id}] ${w.title}, ${w.company}${w.location ? `, ${w.location}` : ''} (${w.start || '?'} to ${w.end ?? 'present'})`)
    if (w.summary) lines.push(`  ${w.summary}`)
    for (const b of w.bullets.slice(0, o.maxBullets ?? 12)) lines.push(`  [${b.id}] ${b.text}`)
    if (w.skills.length) lines.push(`  Tools: ${w.skills.join(', ')}`)
  }
  for (const pr of p.projects) {
    lines.push(`[${pr.id}] Project: ${pr.name}${pr.description ? ` - ${pr.description}` : ''}`)
    for (const b of pr.bullets.slice(0, 6)) lines.push(`  [${b.id}] ${b.text}`)
  }
  for (const e of p.education) lines.push(`[${e.id}] ${[e.degree, e.field].filter(Boolean).join(' in ') || 'Studies'}, ${e.institution}${e.end ? ` (${e.end})` : ''}`)
  for (const c of p.certifications) lines.push(`[${c.id}] Certification: ${c.name}${c.issuer ? `, ${c.issuer}` : ''}${c.date ? ` (${c.date})` : ''}`)
  if (p.languages.length) lines.push(`Languages: ${p.languages.map((l) => `${l.name}${l.fluency ? ` (${l.fluency})` : ''}`).join(', ')}`)
  const auth = p.jobSearch.workAuthorization.map((a) => `${countryName(a.country)}: ${a.authorized ? 'authorized' : 'not authorized'}${a.needsSponsorship ? ', needs sponsorship' : ''}`)
  if (auth.length) lines.push(`Work authorization: ${auth.join('; ')}`)
  if (p.jobSearch.clearance) lines.push(`Security clearance: ${p.jobSearch.clearance}`)
  return lines.join('\n')
}

/** Every citable fact id in the profile. */
export function factIds(p: Profile): Set<string> {
  const ids = new Set<string>()
  for (const w of p.work) {
    ids.add(w.id)
    for (const b of w.bullets) ids.add(b.id)
  }
  for (const x of p.projects) {
    ids.add(x.id)
    for (const b of x.bullets) ids.add(b.id)
  }
  for (const e of p.education) {
    ids.add(e.id)
    for (const b of e.bullets) ids.add(b.id)
  }
  for (const c of p.certifications) ids.add(c.id)
  for (const a of p.awards) ids.add(a.id)
  return ids
}
