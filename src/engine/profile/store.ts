import type { CompletenessItem, ProfileState } from '../../shared/api/profile'
import { EMPTY_PROFILE, type Profile, ProfileSchema } from '../../shared/domain'
import type { Db } from '../core/db'
import { json } from '../core/db'
import { newId } from '../util/text'

export function loadProfile(db: Db): { profile: Profile; updatedAt: number | null; sourceText: string | null } {
  const row = db.get<{ data: string; updated_at: number; source_text: string | null }>('SELECT data, updated_at, source_text FROM profile WHERE id = 1')
  if (!row) return { profile: EMPTY_PROFILE, updatedAt: null, sourceText: null }
  const parsed = ProfileSchema.safeParse(json.parse(row.data, {}))
  return { profile: parsed.success ? parsed.data : EMPTY_PROFILE, updatedAt: row.updated_at, sourceText: row.source_text }
}

/** Fills missing or duplicate ids so every fact can be cited. Existing ids are never changed. */
export function ensureIds(p: Profile): Profile {
  const seen = new Set<string>()
  const fix = (id: string | undefined, prefix: string) => {
    let v = id && !seen.has(id) ? id : newId(prefix)
    while (seen.has(v)) v = newId(prefix)
    seen.add(v)
    return v
  }
  return {
    ...p,
    work: p.work.map((w) => ({ ...w, id: fix(w.id, 'w'), bullets: w.bullets.map((b) => ({ ...b, id: fix(b.id, 'b') })) })),
    education: p.education.map((e) => ({ ...e, id: fix(e.id, 'e'), bullets: e.bullets.map((b) => ({ ...b, id: fix(b.id, 'b') })) })),
    projects: p.projects.map((x) => ({ ...x, id: fix(x.id, 'p'), bullets: x.bullets.map((b) => ({ ...b, id: fix(b.id, 'b') })) })),
    certifications: p.certifications.map((c) => ({ ...c, id: fix(c.id, 'c') })),
    awards: p.awards.map((a) => ({ ...a, id: fix(a.id, 'a') })),
  }
}

export function saveProfile(db: Db, profile: Profile, sourceText?: string, now = Date.now()): Profile {
  const clean = ensureIds(ProfileSchema.parse(profile))
  db.run(
    `INSERT INTO profile (id, data, source_text, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, source_text = COALESCE(excluded.source_text, profile.source_text), updated_at = excluded.updated_at`,
    [JSON.stringify(clean), sourceText ?? null, now],
  )
  return clean
}

const toMonth = (s: string) => {
  const [y, m] = s.split('-')
  return Number(y) * 12 + (m ? Number(m) - 1 : 0)
}

/** Total professional experience in years, merging overlapping roles so they are not counted twice. */
export function yearsOfExperience(p: Profile, now = new Date()): number {
  const nowM = now.getFullYear() * 12 + now.getMonth()
  const spans = p.work
    .filter((w) => /^\d{4}/.test(w.start))
    .map((w) => [toMonth(w.start), w.end && /^\d{4}/.test(w.end) ? toMonth(w.end) : nowM] as [number, number])
    .filter(([a, b]) => b >= a)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let cur: [number, number] | null = null
  for (const s of spans) {
    if (!cur || s[0] > cur[1] + 1) {
      if (cur) total += cur[1] - cur[0] + 1
      cur = [...s]
    } else cur[1] = Math.max(cur[1], s[1])
  }
  if (cur) total += cur[1] - cur[0] + 1
  return Math.round((total / 12) * 10) / 10
}

/** Months of experience with a skill: roles whose text or skill list names it, merged. */
export function skillMonths(p: Profile, skill: string, now = new Date()): number {
  const s = skill.toLowerCase()
  // Whole-word match, so "Go" is not found in "good" or "ago".
  const re = new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`, 'i')
  const matching = p.work.filter((w) => w.skills.some((k) => k.toLowerCase() === s) || w.bullets.some((b) => re.test(b.text)) || re.test(w.summary))
  return Math.round(yearsOfExperience({ ...p, work: matching }, now) * 12)
}

export function completeness(p: Profile): CompletenessItem[] {
  const item = (key: string, label: string, done: boolean, why: string): CompletenessItem => ({ key, label, done, why })
  return [
    item('name', 'Full name', !!p.basics.name, 'Every application asks for it.'),
    item('email', 'Email', /@/.test(p.basics.email), 'Employers reply here, and some sites send verification codes.'),
    item('phone', 'Phone', p.basics.phone.replace(/\D/g, '').length >= 7, 'Most application forms require a phone number.'),
    item('location', 'Location', !!(p.basics.location.city || p.basics.location.country), 'Used for location questions and to filter jobs you can take.'),
    item('work', 'At least one role with bullet points', p.work.some((w) => w.bullets.length > 0), 'Tailored resumes are built only from these lines.'),
    item('skills', 'Five or more skills', p.skills.length >= 5, 'Matching compares job requirements with your skills.'),
    item('authorization', 'Work authorization', p.jobSearch.workAuthorization.length > 0, 'Almost every form asks; OpenApplyr never guesses legal answers.'),
    item('compensation', 'Expected salary', !!p.jobSearch.expectedCompensation, 'Salary questions pause an application until you answer them.'),
    item('over18', 'Age confirmation (18 or older)', p.jobSearch.over18 !== null, 'Many US forms ask; it is never answered for you.'),
  ]
}

export function profileState(db: Db): ProfileState {
  const { profile, updatedAt } = loadProfile(db)
  return { profile, updatedAt, completeness: completeness(profile), yearsOfExperience: yearsOfExperience(profile) }
}

export function loadVoice(db: Db): { description: string; samples: string[] } {
  const row = db.get<{ description: string; samples: string }>('SELECT description, samples FROM voice WHERE id = 1')
  return { description: row?.description ?? '', samples: json.parse<string[]>(row?.samples, []) }
}
