import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BorderStyle, Document, Packer, Paragraph, TabStopType, TextRun } from 'docx'
import { templateById } from '../../../templates/resume'
import { esc, fontFaces, page } from '../../../templates/resume/shared'
import type { TemplateExtras } from '../../../templates/resume'
import type { ResumeContent } from '../../shared/domain'
import type { Ctx } from '../engine'
import { pdfText } from '../profile/read'

export const fontsDir = (ctx: Ctx) => join(ctx.paths.resources, 'assets', 'fonts')

export function resumeHtml(ctx: Ctx, content: ResumeContent, templateId: string, pageSize: 'Letter' | 'A4', extras: TemplateExtras = {}): string {
  return templateById(templateId).render({ content, pageSize, fontsDir: fontsDir(ctx), extras })
}

/** "Maya Okafor" -> "Maya_Okafor_Resume.pdf". Recruiters see this name. */
export function fileBase(name: string, kind: 'Resume' | 'CV' | 'Cover_Letter'): string {
  const clean = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${clean || 'Candidate'}_${kind}`
}

export async function writePdf(ctx: Ctx, html: string, pageSize: 'Letter' | 'A4', dir: string, base: string): Promise<string> {
  const bytes = await ctx.host.request('pdf', { html, pageSize })
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${base}.pdf`)
  writeFileSync(path, bytes)
  return path
}

const TWIPS = { Letter: { w: 12240, h: 15840 }, A4: { w: 11906, h: 16838 } }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const d = (s: string | null) => {
  if (s === null) return 'Present'
  const [y, m] = s.split('-')
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : (y ?? '')
}

/** Single-column DOCX with Word's own bullets and a right tab for dates: what parsers expect. */
export async function resumeDocx(c: ResumeContent, pageSize: 'Letter' | 'A4'): Promise<Buffer> {
  const size = TWIPS[pageSize]
  const right = size.w - 2 * 1008
  const heading = (text: string) =>
    new Paragraph({
      spacing: { before: 200, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999', space: 2 } },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 19, characterSpacing: 20 })],
    })
  const roleLine = (left: string, rightText: string) =>
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: right }],
      spacing: { before: 100 },
      children: [new TextRun({ text: left, bold: true }), new TextRun({ text: `\t${rightText}`, size: 19 })],
    })
  const children: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: c.name, bold: true, size: 36 })] }),
    ...(c.headline ? [new Paragraph({ children: [new TextRun({ text: c.headline, size: 22 })] })] : []),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: [c.contact.location, c.contact.email, c.contact.phone, ...c.contact.links.map((l) => l.url)].filter(Boolean).join(' | '), size: 19 })],
    }),
  ]
  if (c.summary.text) children.push(heading('Summary'), new Paragraph({ children: [new TextRun(c.summary.text)] }))
  if (c.work.length) {
    children.push(heading('Experience'))
    for (const w of c.work) {
      children.push(roleLine(w.title, `${d(w.start)} – ${d(w.end)}`))
      children.push(new Paragraph({ children: [new TextRun({ text: [w.company, w.location].filter(Boolean).join(', '), italics: true })] }))
      for (const b of w.bullets) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.text)] }))
    }
  }
  if (c.projects.length) {
    children.push(heading('Projects'))
    for (const p of c.projects) {
      children.push(roleLine(p.name, p.url))
      for (const b of p.bullets) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.text)] }))
    }
  }
  if (c.education.length) {
    children.push(heading('Education'))
    for (const e of c.education) {
      children.push(roleLine([e.degree, e.field].filter(Boolean).join(' in ') || e.institution, e.end ? d(e.end) : ''))
      children.push(new Paragraph({ children: [new TextRun({ text: e.institution, italics: true })] }))
    }
  }
  if (c.skills.length) children.push(heading('Skills'), new Paragraph({ children: [new TextRun(c.skills.join(', '))] }))
  if (c.certifications.length) {
    children.push(heading('Certifications'))
    for (const x of c.certifications) children.push(new Paragraph({ children: [new TextRun([x.name, x.issuer, x.date].filter(Boolean).join(', '))] }))
  }
  const doc = new Document({
    creator: c.name,
    title: `${c.name} Resume`,
    styles: { default: { document: { run: { font: 'Calibri', size: 21 }, paragraph: { spacing: { line: 264 } } } } },
    sections: [{ properties: { page: { size: { width: size.w, height: size.h }, margin: { top: 900, bottom: 900, left: 1008, right: 1008 } } }, children }],
  })
  return Packer.toBuffer(doc)
}

export function resumeTxt(c: ResumeContent): string {
  const out = [c.name, c.headline, [c.contact.location, c.contact.email, c.contact.phone, ...c.contact.links.map((l) => l.url)].filter(Boolean).join(' | '), '']
  if (c.summary.text) out.push('SUMMARY', c.summary.text, '')
  if (c.work.length) {
    out.push('EXPERIENCE')
    for (const w of c.work) {
      out.push(`${w.title}, ${w.company}${w.location ? `, ${w.location}` : ''} (${d(w.start)} – ${d(w.end)})`)
      for (const b of w.bullets) out.push(`- ${b.text}`)
      out.push('')
    }
  }
  if (c.education.length) {
    out.push('EDUCATION')
    for (const e of c.education) out.push(`${[e.degree, e.field].filter(Boolean).join(' in ')}, ${e.institution}${e.end ? ` (${d(e.end)})` : ''}`)
    out.push('')
  }
  if (c.skills.length) out.push('SKILLS', c.skills.join(', '))
  return out.join('\n').trim()
}

/** A plain letter page in the same type family as the chosen resume template. */
export function letterHtml(ctx: Ctx, opts: { name: string; contact: string[]; body: string; templateId: string; pageSize: 'Letter' | 'A4'; date: string }): string {
  const serif = ['classic', 'ledger'].includes(opts.templateId)
  const faces = serif
    ? [{ family: 'Source Serif 4', file: 'source-serif-4', weight: 400 }, { family: 'Source Serif 4', file: 'source-serif-4', weight: 600 }]
    : [{ family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 400 }, { family: 'IBM Plex Sans', file: 'ibm-plex-sans', weight: 600 }]
  const family = serif ? "'Source Serif 4', Georgia, serif" : "'IBM Plex Sans', Arial, sans-serif"
  const css = `${fontFaces(fontsDir(ctx), faces)}
body { font-family: ${family}; font-size: 10.8pt; line-height: 1.55; color: #1C2420; padding: 0.9in 1in; }
h1 { font-size: 16pt; font-weight: 600; }
.contact { font-size: 9.5pt; color: #4b534e; margin-top: 3pt; }
.date { margin: 26pt 0 18pt; color: #4b534e; }
p { margin-bottom: 10pt; max-width: 6.2in; }`
  const paras = opts.body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
  return page({ content: {} as never, pageSize: opts.pageSize, fontsDir: fontsDir(ctx), extras: {} }, css, `<h1>${esc(opts.name)}</h1><div class="contact">${opts.contact.map(esc).join(' · ')}</div><div class="date">${esc(opts.date)}</div>${paras}`, `${opts.name} Cover Letter`)
}

export type AtsCheck = { label: string; ok: boolean; detail: string }
export type AtsReport = { text: string; checks: AtsCheck[]; bytes: number }

/**
 * Reads the generated PDF back as a parser would and checks what matters: contact details found, section
 * headings present, experience in order, and a reasonable file size. This replaces a made-up "ATS score".
 */
export async function atsPreview(pdf: Uint8Array, c: ResumeContent): Promise<AtsReport> {
  const text = await pdfText(pdf)
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  const checks: AtsCheck[] = []
  const has = (s: string) => !!s && lower.includes(s.toLowerCase().replace(/\s+/g, ' '))
  checks.push({ label: 'Name', ok: has(c.name), detail: has(c.name) ? 'Found at the top.' : 'Your name was not found in the text layer.' })
  checks.push({ label: 'Email', ok: !c.contact.email || has(c.contact.email), detail: c.contact.email ? (has(c.contact.email) ? c.contact.email : 'Not readable.') : 'No email in your profile.' })
  const digits = c.contact.phone.replace(/\D/g, '')
  const phoneOk = !digits || flat.replace(/\D/g, '').includes(digits)
  checks.push({ label: 'Phone', ok: phoneOk, detail: digits ? (phoneOk ? c.contact.phone : 'Not readable.') : 'No phone in your profile.' })
  const headings = ['experience', 'education', 'skills'].filter((h) => (h === 'education' ? c.education.length : h === 'skills' ? c.skills.length : c.work.length))
  const missingHeadings = headings.filter((h) => !lower.includes(h))
  checks.push({ label: 'Section headings', ok: missingHeadings.length === 0, detail: missingHeadings.length ? `Missing: ${missingHeadings.join(', ')}.` : 'Experience, education and skills are labeled.' })
  let pos = -1
  let ordered = true
  for (const w of c.work) {
    const i = lower.indexOf(w.title.toLowerCase(), pos + 1)
    if (i < 0 || i < pos) {
      ordered = false
      break
    }
    pos = i
  }
  checks.push({ label: 'Reading order', ok: ordered, detail: ordered ? 'Roles read top to bottom in order.' : 'A parser would read your roles out of order.' })
  const firstBullet = c.work[0]?.bullets[0]?.text
  const bulletOk = !firstBullet || has(firstBullet.slice(0, 40))
  checks.push({ label: 'Bullet text', ok: bulletOk, detail: bulletOk ? 'Bullet points are plain text.' : 'Bullet text did not come through cleanly.' })
  checks.push({ label: 'File size', ok: pdf.byteLength < 2 * 1024 * 1024, detail: `${Math.round(pdf.byteLength / 1024)} KB` })
  return { text, checks, bytes: pdf.byteLength }
}
