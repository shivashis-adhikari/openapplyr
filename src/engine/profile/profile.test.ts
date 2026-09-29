import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, Packer, Paragraph } from 'docx'
import { describe, expect, it } from 'vitest'
import { ProfileSchema } from '../../shared/domain'
import { SAMPLE_RESUME, makePdf, makeZip, testCtx, testServices } from '../test/harness'
import { heuristicResume, toProfile, unverifiedStrings } from './extract'
import { fromJsonResume, fromLinkedInZip, splitBullets } from './formats'
import { registerProfileHandlers } from './handlers'
import { documentText } from './read'
import { completeness, ensureIds, loadProfile, saveProfile, skillMonths, yearsOfExperience } from './store'

describe('resume extraction (offline model)', () => {
  it('parses a typical single-column resume', () => {
    const x = heuristicResume(SAMPLE_RESUME)
    expect(x.basics.name).toBe('Maya Okafor')
    expect(x.basics.email).toBe('maya.okafor@example.com')
    expect(x.work).toHaveLength(2)
    expect(x.work[0]).toMatchObject({ title: 'Senior Backend Engineer', company: 'Northwind Payments', start: '2021-03', end: 'present' })
    expect(x.work[0]!.bullets).toHaveLength(3)
    expect(x.work[1]).toMatchObject({ company: 'Tidewater Analytics', start: '2017-06', end: '2021-02' })
    expect(x.education[0]!.institution).toBe('University of Porto')
    expect(x.skills).toContain('Terraform')
  })

  it('flags extracted text that is not in the source', () => {
    const p = toProfile(heuristicResume(SAMPLE_RESUME))
    expect(unverifiedStrings(p, SAMPLE_RESUME)).toEqual([])
    p.work[0]!.bullets.push({ id: 'b_x', text: 'Won the Turing Award for distributed consensus research' })
    p.skills.push({ name: 'Rust', years: null, category: '' })
    const flagged = unverifiedStrings(p, SAMPLE_RESUME).map((u) => u.text)
    expect(flagged).toContain('Won the Turing Award for distributed consensus research')
    expect(flagged).toContain('Rust')
  })
})

describe('structured formats', () => {
  it('maps JSON Resume', () => {
    const p = fromJsonResume({
      basics: { name: 'A B', email: 'a@b.co', label: 'Designer', location: { city: 'Pune', countryCode: 'IN' }, profiles: [{ network: 'Dribbble', url: 'https://dribbble.com/ab' }] },
      work: [{ name: 'Acme', position: 'Designer', startDate: '2020-01-15', endDate: '', highlights: ['Shipped the design system'] }],
      skills: [{ name: 'Design', keywords: ['Figma', 'Prototyping'] }],
    })
    expect(p.basics.location.country).toBe('IN')
    expect(p.work[0]).toMatchObject({ company: 'Acme', start: '2020-01', end: null })
    expect(p.work[0]!.bullets[0]!.text).toBe('Shipped the design system')
    expect(p.skills.map((s) => s.name)).toEqual(['Figma', 'Prototyping'])
  })

  it('maps a LinkedIn data export without a model', () => {
    const zip = makeZip({
      'Profile.csv': 'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\nMaya,Okafor,,,,Backend engineer,Payments,,,,,"[PORTFOLIO:https://maya.dev]",\n',
      'Positions.csv': 'Company Name,Title,Description,Location,Started On,Finished On\nNorthwind Payments,Senior Backend Engineer,"Cut settlement time\n• Led the PostgreSQL upgrade",Lisbon,Mar 2021,\n',
      'Email Addresses.csv': 'Email Address,Confirmed,Primary,Updated On\nmaya@example.com,Yes,Yes,\n',
      'Skills.csv': 'Name\nGo\nKafka\n',
    })
    const { profile, sourceText } = fromLinkedInZip(zip)
    expect(profile.basics).toMatchObject({ name: 'Maya Okafor', email: 'maya@example.com', headline: 'Backend engineer' })
    expect(profile.basics.links[0]!.url).toBe('https://maya.dev')
    expect(profile.work[0]).toMatchObject({ company: 'Northwind Payments', start: '2021-03', end: null })
    expect(profile.work[0]!.bullets.map((b) => b.text)).toEqual(['Cut settlement time', 'Led the PostgreSQL upgrade'])
    expect(profile.skills.map((s) => s.name)).toEqual(['Go', 'Kafka'])
    expect(sourceText).toContain('positions.csv')
    expect(() => fromLinkedInZip(makeZip({ 'random.csv': 'a\n1' }))).toThrow(/LinkedIn/)
  })

  it('splits bullet-style descriptions', () => {
    expect(splitBullets('• One thing • Another thing\n- Third')).toEqual(['One thing', 'Another thing', 'Third'])
  })
})

describe('documentText', () => {
  it('reads a text PDF and a DOCX, and rejects image-only PDFs', async () => {
    const ctx = testCtx()
    const pdfPath = join(ctx.paths.data, 'r.pdf')
    writeFileSync(pdfPath, makePdf(SAMPLE_RESUME.split('\n').slice(0, 12)))
    const pdf = await documentText(pdfPath)
    expect(pdf).toContain('Maya Okafor')
    expect(pdf).toContain('Northwind Payments')

    const docxPath = join(ctx.paths.data, 'r.docx')
    const doc = new Document({ sections: [{ children: SAMPLE_RESUME.split('\n').map((t) => new Paragraph(t)) }] })
    writeFileSync(docxPath, await Packer.toBuffer(doc))
    expect(await documentText(docxPath)).toContain('Tidewater Analytics')

    const blank = join(ctx.paths.data, 'scan.pdf')
    writeFileSync(blank, makePdf([]))
    await expect(documentText(blank)).rejects.toMatchObject({ code: 'SCANNED_PDF' })
    await expect(documentText(join(ctx.paths.data, 'x.doc'))).rejects.toMatchObject({ code: 'OLD_WORD' })
  })
})

describe('profile store', () => {
  it('keeps existing ids, repairs duplicates, and round-trips', () => {
    const ctx = testCtx()
    const p = toProfile(heuristicResume(SAMPLE_RESUME))
    const firstId = p.work[0]!.id
    p.work[1]!.id = firstId // duplicate
    const saved = saveProfile(ctx.db, p)
    expect(saved.work[0]!.id).toBe(firstId)
    expect(saved.work[1]!.id).not.toBe(firstId)
    expect(loadProfile(ctx.db).profile.work).toHaveLength(2)
    expect(ensureIds(saved)).toEqual(saved)
  })

  it('computes experience without double counting overlapping roles', () => {
    const base = ProfileSchema.parse({})
    const p = {
      ...base,
      work: [
        { ...base.work[0], id: 'w1', company: 'A', title: 'x', location: '', start: '2018-01', end: '2019-12', summary: '', bullets: [], skills: ['Go'] },
        { id: 'w2', company: 'B', title: 'y', location: '', start: '2019-06', end: '2020-12', summary: '', bullets: [{ id: 'b1', text: 'Used Kafka' }], skills: [] },
      ],
    }
    expect(yearsOfExperience(p, new Date(2024, 0, 1))).toBe(3)
    expect(skillMonths(p, 'go')).toBe(24)
    expect(skillMonths(p, 'kafka')).toBe(19)
  })

  it('reports what is missing and why', () => {
    const items = completeness(ProfileSchema.parse({}))
    expect(items.every((i) => !i.done)).toBe(true)
    expect(items.find((i) => i.key === 'authorization')!.why).toMatch(/never guesses/)
  })
})

describe('profile handlers', () => {
  it('imports pasted text through the model path and saves', async () => {
    const ctx = testCtx()
    registerProfileHandlers(ctx, testServices(ctx))
    const res = (await ctx.router.handle('profile.import', { text: SAMPLE_RESUME })) as { draft: { work: unknown[] }; unverified: unknown[]; method: string }
    expect(res.method).toBe('model')
    expect(res.draft.work).toHaveLength(2)
    expect(res.unverified).toEqual([])
    const state = (await ctx.router.handle('profile.save', { profile: res.draft })) as { yearsOfExperience: number }
    expect(state.yearsOfExperience).toBeGreaterThan(8)
    await expect(ctx.router.handle('profile.import', { text: 'too short' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
