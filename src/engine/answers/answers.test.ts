import { describe, expect, it } from 'vitest'
import type { Profile } from '../../shared/domain'
import { heuristicResume, toProfile } from '../profile/extract'
import { SAMPLE_RESUME, fixture, testCtx, testServices } from '../test/harness'
import { type FormQuestion, classifyQuestion, countryInQuestion, pickOption } from './questions'
import { type ResolveContext, bankSave, resolveForm } from './resolve'

type GhQuestion = { label: string; required: boolean; fields: { name: string; type: string; values: { label: string }[] }[] }

const GH_TYPES: Record<string, FormQuestion['type']> = { input_text: 'text', textarea: 'textarea', input_file: 'file', multi_value_single_select: 'select', multi_value_multi_select: 'multiselect' }
const fromGreenhouse = (q: GhQuestion): FormQuestion => {
  const f = q.fields[0]!
  return { fieldName: f.name, label: q.label.trim(), type: GH_TYPES[f.type] ?? 'text', required: q.required, options: f.values.map((v) => v.label) }
}

describe('classifyQuestion on a real Greenhouse form (Stripe)', () => {
  const gh = (fixture('greenhouse') as { questions: { questions: GhQuestion[]; location_questions: GhQuestion[] } }).questions
  const keys = [...gh.questions, ...gh.location_questions].filter((q) => q.fields[0]!.type !== 'input_hidden').map((q) => classifyQuestion(fromGreenhouse(q))?.key ?? null)

  it('places every question', () => {
    expect(keys).toEqual([
      'first_name',
      'last_name',
      'email',
      'phone',
      'resume',
      'cover_letter_file',
      'current_employer',
      'current_title',
      'location_country',
      'work_country',
      'authorized:job',
      'sponsorship',
      'consent_privacy',
      'location_city',
    ])
  })
})

describe('classifyQuestion edge cases', () => {
  const c = (label: string, type: FormQuestion['type'] = 'text', options: string[] = []) => classifyQuestion({ label, type, options })?.key ?? null
  it('keeps legal questions away from location fields', () => {
    expect(c('Are you authorized to work in the location(s) you selected?', 'select', ['Yes', 'No'])).toBe('authorized:job')
    expect(c('Which visa situation fits you best?', 'select', ['EU citizen', 'Need a visa'])).toBe('visa_status')
    expect(c('What country do you currently live in?')).toBe('location_country')
    expect(c('Location')).toBe('location_city')
    expect(c('Are you willing to relocate to our Lisbon location?')).toBe('relocation')
  })
  it('reads the skill out of years-of-experience questions', () => {
    expect(c('How many years of experience do you have with Go?', 'number')).toBe('skill_years:go')
    expect(c('How many years of experience do you have in total?', 'number')).toBe('years_experience')
    expect(c('Years of professional experience', 'number')).toBe('years_experience')
  })
  it('does not read "us" as the United States', () => {
    expect(countryInQuestion('Are you legally authorized to work in the US?')).toBe('US')
    expect(countryInQuestion('Are you authorized to work in the United States?')).toBe('US')
    expect(countryInQuestion('Tell us: are you authorized to work where you would join us?')).toBeNull()
    expect(countryInQuestion('Do you have the right to work in the UK?')).toBe('GB')
    expect(c('Tell us if you are authorized to work in the country of this role', 'select', ['Yes', 'No'])).toBe('authorized:job')
  })
  it('sends unknown free-text questions to the open bucket and leaves unknown short ones alone', () => {
    expect(c('Describe a system you are proud of.', 'textarea')).toMatch(/^open:/)
    expect(c('Favourite colour?')).toBeNull()
  })
})

describe('pickOption', () => {
  it('matches yes/no, declines and long options', () => {
    expect(pickOption(['Yes', 'No'], 'No')).toBe('No')
    expect(pickOption(['Yes, I am authorized', 'No, I am not authorized'], 'Yes')).toBe('Yes, I am authorized')
    expect(pickOption(['No, I will not require sponsorship', 'Yes, I will require sponsorship'], 'No')).toBe('No, I will not require sponsorship')
    expect(pickOption(['Male', 'Female', "I don't wish to answer"], 'Decline to self-identify')).toBe("I don't wish to answer")
    expect(pickOption(['Portugal', 'Spain'], 'portugal')).toBe('Portugal')
    expect(pickOption(['Bachelor’s Degree', 'Master’s Degree'], 'Bachelor’s Degree in Computer Science')).toBe('Bachelor’s Degree')
    expect(pickOption(['Red', 'Blue'], 'Green')).toBeNull()
    expect(pickOption(['Male', 'Female'], 'Decline to self-identify')).toBeNull()
  })
})

describe('resolveForm', () => {
  const base = toProfile(heuristicResume(SAMPLE_RESUME))
  const q = (label: string, type: FormQuestion['type'] = 'text', options: string[] = [], required = true): FormQuestion => ({ fieldName: label, label, type, required, options })
  const setup = (profile: Profile = base, allowGenerated = false) => {
    const ctx = testCtx()
    const s = testServices(ctx)
    const companyId = ctx.db.run("INSERT INTO companies (name, name_norm, created_at) VALUES ('Tidewater', 'tidewater', 0)").lastInsertRowid
    const c: ResolveContext = { profile, job: { title: 'Senior Backend Engineer', company: 'Tidewater', companyId, country: 'PT', description: 'We run Go services on AWS.' }, db: ctx.db, letterText: null, allowGenerated }
    return { ctx, s, c, companyId }
  }
  const by = (answers: Awaited<ReturnType<typeof resolveForm>>) => Object.fromEntries(answers.map((a) => [a.question, a]))

  it('fills contact and work facts from the profile', async () => {
    const { s, c } = setup()
    const r = by(await resolveForm([q('First Name'), q('Last Name'), q('Email'), q('Who is your current or previous employer?'), q('Resume/CV', 'file')], c, s.ai))
    expect(r['First Name']).toMatchObject({ answer: 'Maya', source: 'profile', needsUser: false })
    expect(r['Last Name']!.answer).toBe('Okafor')
    expect(r['Email']!.answer).toBe('maya.okafor@example.com')
    expect(r['Who is your current or previous employer?']!.answer).toBe('Northwind Payments')
    expect(r['Resume/CV']).toMatchObject({ kind: 'file', answer: 'resume' })
  })

  it('matches countries across spellings ("UK", "The Netherlands")', async () => {
    const { s, c } = setup({ ...base, basics: { ...base.basics, location: { city: 'Leeds', region: '', country: 'GB' } } })
    const r = await resolveForm([q('Please select the country where you currently reside.', 'select', ['The Netherlands', 'UK', 'US', 'Other'])], c, s.ai)
    expect(r[0]).toMatchObject({ answer: 'UK', needsUser: false })
  })

  it('never writes legal or salary answers, even when generated answers are allowed', async () => {
    const { s, c } = setup(base, true)
    const r = by(
      await resolveForm(
        [q('Are you legally authorized to work in Portugal?', 'select', ['Yes', 'No']), q('What are your salary expectations?'), q('Have you ever been convicted of a felony?', 'select', ['Yes', 'No'])],
        c,
        s.ai,
      ),
    )
    for (const a of Object.values(r)) expect(a).toMatchObject({ answer: '', source: 'user', needsUser: true })
  })

  it('answers legal questions the profile records, in the form\'s own option wording', async () => {
    const profile: Profile = { ...base, jobSearch: { ...base.jobSearch, workAuthorization: [{ country: 'PT', authorized: true, needsSponsorship: false }] } }
    const { s, c } = setup(profile)
    const r = by(
      await resolveForm(
        [
          q('Are you authorized to work in the location(s) you selected?', 'select', ['Yes', 'No']),
          q('Will you now or in the future require sponsorship?', 'select', ['Yes, I will require sponsorship', 'No, I will not require sponsorship']),
        ],
        c,
        s.ai,
      ),
    )
    expect(r['Are you authorized to work in the location(s) you selected?']).toMatchObject({ answer: 'Yes', needsUser: false })
    expect(r['Will you now or in the future require sponsorship?']!.answer).toBe('No, I will not require sponsorship')
  })

  it('declines EEO questions by default and asks when no decline option exists', async () => {
    const { s, c } = setup()
    const r = by(await resolveForm([q('Gender', 'select', ['Male', 'Female', 'Decline to self-identify']), q('Veteran status', 'select', ['I am a veteran', 'I am not a veteran'])], c, s.ai))
    expect(r['Gender']).toMatchObject({ answer: 'Decline to self-identify', needsUser: false })
    expect(r['Veteran status']!.needsUser).toBe(true)
  })

  it('agrees to required acknowledgements but leaves real consent choices to the user', async () => {
    const { s, c } = setup()
    const r = by(
      await resolveForm(
        [q('I acknowledge the privacy notice', 'checkbox'), q('Please confirm if you consent to BrightHire recording this interview', 'select', ['Yes', 'No']), q('I consent to marketing emails', 'checkbox', [], false)],
        c,
        s.ai,
      ),
    )
    expect(r['I acknowledge the privacy notice']).toMatchObject({ answer: 'Yes', needsUser: false })
    expect(r['Please confirm if you consent to BrightHire recording this interview']).toMatchObject({ answer: '', needsUser: true })
    expect(r['I consent to marketing emails']).toMatchObject({ answer: '', needsUser: false })
  })

  it('computes years with a skill from the roles that show it, and asks when there is no evidence', async () => {
    const { s, c } = setup()
    const r = by(await resolveForm([q('How many years of experience do you have with Kafka?', 'number'), q('How many years of experience do you have with COBOL?', 'number')], c, s.ai))
    expect(r['How many years of experience do you have with Kafka?']).toMatchObject({ answer: '3', source: 'computed' })
    expect(r['How many years of experience do you have with COBOL?']).toMatchObject({ answer: '', needsUser: true })
  })

  it('prefers a saved answer for this company over a general one and over the profile', async () => {
    const { ctx, s, c, companyId } = setup()
    bankSave(ctx.db, { key: 'email', question: 'Email', answer: 'maya.jobs@example.com', kind: 'contact', companyId: null, source: 'user' }, 0)
    bankSave(ctx.db, { key: 'how_heard', question: 'How did you hear about us?', answer: 'LinkedIn', kind: 'choice', companyId: null, source: 'user' }, 0)
    bankSave(ctx.db, { key: 'how_heard', question: 'How did you hear about us?', answer: 'Referral', kind: 'choice', companyId, source: 'user' }, 0)
    const r = by(await resolveForm([q('Email'), q('How did you hear about us?', 'select', ['LinkedIn', 'Referral', 'Other'])], c, s.ai))
    expect(r['Email']).toMatchObject({ answer: 'maya.jobs@example.com', source: 'bank' })
    expect(r['How did you hear about us?']!.answer).toBe('Referral')
  })

  it('writes open answers only when the hunt allows it', async () => {
    const question = q('Why do you want to work at Tidewater?', 'textarea')
    const off = setup()
    expect((await resolveForm([question], off.c, off.s.ai))[0]).toMatchObject({ answer: '', needsUser: true })
    const on = setup(base, true)
    const a = (await resolveForm([question], on.c, on.s.ai))[0]!
    expect(a).toMatchObject({ kind: 'open', source: 'generated', needsUser: false })
    expect(a.answer).toContain('Northwind Payments')
  })
})
