import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { regionDefaults, templateById } from '../../../templates/resume'
import type { AtsReport, LetterDetail } from '../../shared/api/documents'
import type { FactLockIssue, Profile, ResumeContent, ResumeDetail, ResumeSummary, ReviewIssue, StyleIssue } from '../../shared/domain'
import { json } from '../core/db'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { countryName } from '../jobs/geo'
import { loadProfile } from '../profile/store'
import { atsPreview, fileBase, letterHtml, resumeDocx, resumeHtml, resumeTxt, writePdf } from './render'

type ResumeRow = {
  id: number
  kind: 'base' | 'tailored'
  name: string
  base_id: number | null
  job_id: number | null
  content: string
  template_id: string
  page_size: 'Letter' | 'A4'
  pdf_path: string | null
  docx_path: string | null
  factlock: string | null
  review: string | null
  keywords: string | null
  ats: string | null
  created_at: number
  updated_at: number
}

const summary = (r: ResumeRow): ResumeSummary => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  jobId: r.job_id,
  templateId: r.template_id,
  updatedAt: r.updated_at,
  hasPdf: !!r.pdf_path && existsSync(r.pdf_path),
})

export function resumeRow(ctx: Ctx, id: number): ResumeRow {
  const r = ctx.db.get<ResumeRow>('SELECT * FROM resumes WHERE id = ?', [id])
  if (!r) throw new AppError('NOT_FOUND', 'That resume no longer exists.', { permanent: true })
  return r
}

export function resumeDetail(ctx: Ctx, id: number): ResumeDetail {
  const r = resumeRow(ctx, id)
  return {
    ...summary(r),
    content: json.parse(r.content, {} as ResumeContent),
    pageSize: r.page_size,
    pdfPath: r.pdf_path,
    docxPath: r.docx_path,
    factLock: json.parse<FactLockIssue[]>(r.factlock, []),
    review: json.parse<ReviewIssue[]>(r.review, []),
    keywords: json.parse(r.keywords, { present: [], inProfileNotResume: [], notInProfile: [] }),
  }
}

export function listResumes(ctx: Ctx, kind: 'all' | 'base' | 'tailored'): ResumeSummary[] {
  return ctx.db.all<ResumeRow>(`SELECT * FROM resumes ${kind === 'all' ? '' : 'WHERE kind = ?'} ORDER BY kind, updated_at DESC`, kind === 'all' ? [] : [kind]).map(summary)
}

export function insertResume(
  ctx: Ctx,
  r: { kind: 'base' | 'tailored'; name: string; baseId?: number | null; jobId?: number | null; content: ResumeContent; templateId: string; pageSize: 'Letter' | 'A4'; factLock?: FactLockIssue[]; review?: ReviewIssue[]; keywords?: unknown },
): number {
  const now = ctx.now()
  return ctx.db.run(
    `INSERT INTO resumes (kind, name, base_id, job_id, content, template_id, page_size, factlock, review, keywords, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.kind, r.name, r.baseId ?? null, r.jobId ?? null, JSON.stringify(r.content), r.templateId, r.pageSize, JSON.stringify(r.factLock ?? []), JSON.stringify(r.review ?? []), JSON.stringify(r.keywords ?? null), now, now],
  ).lastInsertRowid
}

export function updateResume(ctx: Ctx, id: number, patch: { name?: string | undefined; content?: ResumeContent | undefined; templateId?: string | undefined; pageSize?: 'Letter' | 'A4' | undefined }): void {
  const r = resumeRow(ctx, id)
  ctx.db.run(
    `UPDATE resumes SET name = ?, content = ?, template_id = ?, page_size = ?, pdf_path = NULL, docx_path = NULL, ats = NULL, updated_at = ? WHERE id = ?`,
    [patch.name ?? r.name, patch.content ? JSON.stringify(patch.content) : r.content, patch.templateId ? templateById(patch.templateId).id : r.template_id, patch.pageSize ?? r.page_size, ctx.now(), id],
  )
}

export function extrasFor(profile: Profile): { noticePeriod?: string; workAuthorization?: string } {
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))
  const authorized = profile.jobSearch.workAuthorization.filter((a) => a.authorized)
  const free = authorized.filter((a) => !a.needsSponsorship).map((a) => countryName(a.country))
  const sponsor = authorized.filter((a) => a.needsSponsorship).map((a) => countryName(a.country))
  const auth = [free.length ? `Authorized to work in ${list(free)}` : '', sponsor.length ? `Needs visa sponsorship in ${list(sponsor)}` : ''].filter(Boolean).join('. ')
  return { ...(profile.jobSearch.noticePeriod ? { noticePeriod: profile.jobSearch.noticePeriod } : {}), ...(auth ? { workAuthorization: auth } : {}) }
}

/** Renders PDF and DOCX for a resume (if not already current) and returns their paths. */
export async function renderResume(ctx: Ctx, id: number): Promise<{ pdfPath: string; docxPath: string }> {
  const r = resumeRow(ctx, id)
  if (r.pdf_path && r.docx_path && existsSync(r.pdf_path) && existsSync(r.docx_path)) return { pdfPath: r.pdf_path, docxPath: r.docx_path }
  const content = json.parse<ResumeContent>(r.content, {} as ResumeContent)
  const { profile } = loadProfile(ctx.db)
  const tpl = templateById(r.template_id)
  const pageSize = tpl.id === 'cv-eu' || tpl.id === 'india' ? 'A4' : r.page_size
  const dir = join(ctx.paths.documents, 'resumes', String(id))
  const base = fileBase(content.name, tpl.id === 'cv-eu' ? 'CV' : 'Resume')
  const pdfPath = await writePdf(ctx, resumeHtml(ctx, content, tpl.id, pageSize, extrasFor(profile)), pageSize, dir, base)
  const docxPath = join(dir, `${base}.docx`)
  writeFileSync(docxPath, await resumeDocx(content, pageSize))
  ctx.db.run('UPDATE resumes SET pdf_path = ?, docx_path = ? WHERE id = ?', [pdfPath, docxPath, id])
  ctx.bus.changed('documents')
  return { pdfPath, docxPath }
}

export async function resumeAts(ctx: Ctx, id: number): Promise<AtsReport> {
  const r = resumeRow(ctx, id)
  if (r.ats && r.pdf_path && existsSync(r.pdf_path)) return json.parse<AtsReport>(r.ats, { text: '', checks: [], bytes: 0 })
  const { pdfPath } = await renderResume(ctx, id)
  const report = await atsPreview(new Uint8Array(readFileSync(pdfPath)), json.parse<ResumeContent>(r.content, {} as ResumeContent))
  ctx.db.run('UPDATE resumes SET ats = ? WHERE id = ?', [JSON.stringify(report), id])
  return report
}

export async function exportResume(ctx: Ctx, id: number, format: 'pdf' | 'docx' | 'txt', path: string): Promise<string> {
  if (format === 'txt') {
    writeFileSync(path, resumeTxt(json.parse<ResumeContent>(resumeRow(ctx, id).content, {} as ResumeContent)))
    return path
  }
  const paths = await renderResume(ctx, id)
  copyFileSync(format === 'pdf' ? paths.pdfPath : paths.docxPath, path)
  return path
}

export function deleteResume(ctx: Ctx, id: number): void {
  const r = resumeRow(ctx, id)
  if (r.kind === 'base' && ctx.db.get('SELECT 1 FROM hunts WHERE base_resume_id = ?', [id])) {
    throw new AppError('IN_USE', 'A hunt uses this resume as its base. Pick another resume for that hunt first.', { permanent: true })
  }
  ctx.db.run('DELETE FROM resumes WHERE id = ?', [id])
  if (r.pdf_path) rmSync(dirname(r.pdf_path), { recursive: true, force: true })
}

export function defaultTemplate(ctx: Ctx): { templateId: string; pageSize: 'Letter' | 'A4' } {
  const d = regionDefaults(ctx.settings.get().region)
  return { templateId: d.template, pageSize: d.pageSize }
}

// ---------------------------------------------------------------------------
// Cover letters

type LetterRow = { id: number; job_id: number | null; body: string; style: string | null; pdf_path: string | null; template_id: string | null; updated_at: number }

export function letterDetail(ctx: Ctx, id: number): LetterDetail {
  const r = ctx.db.get<LetterRow>('SELECT * FROM cover_letters WHERE id = ?', [id])
  if (!r) throw new AppError('NOT_FOUND', 'That cover letter no longer exists.', { permanent: true })
  return { id: r.id, jobId: r.job_id, body: r.body, issues: json.parse<StyleIssue[]>(r.style, []), pdfPath: r.pdf_path, templateId: r.template_id ?? 'modern', updatedAt: r.updated_at }
}

export function insertLetter(ctx: Ctx, l: { jobId: number | null; body: string; plan: unknown; issues: StyleIssue[]; templateId: string }): number {
  const now = ctx.now()
  return ctx.db.run('INSERT INTO cover_letters (job_id, body, plan, style, template_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    l.jobId,
    l.body,
    JSON.stringify(l.plan),
    JSON.stringify(l.issues),
    l.templateId,
    now,
    now,
  ]).lastInsertRowid
}

export async function renderLetter(ctx: Ctx, id: number, pageSize: 'Letter' | 'A4'): Promise<string> {
  const l = letterDetail(ctx, id)
  if (l.pdfPath && existsSync(l.pdfPath)) return l.pdfPath
  const { profile } = loadProfile(ctx.db)
  const b = profile.basics
  const html = letterHtml(ctx, {
    name: b.name,
    contact: [b.email, b.phone, [b.location.city, b.location.country ? countryName(b.location.country) : ''].filter(Boolean).join(', ')].filter(Boolean),
    body: l.body,
    templateId: l.templateId,
    pageSize,
    date: new Intl.DateTimeFormat(pageSize === 'Letter' ? 'en-US' : 'en-GB', { dateStyle: 'long' }).format(new Date(ctx.now())),
  })
  const path = await writePdf(ctx, html, pageSize, join(ctx.paths.documents, 'letters', String(id)), fileBase(b.name, 'Cover_Letter'))
  ctx.db.run('UPDATE cover_letters SET pdf_path = ? WHERE id = ?', [path, id])
  return path
}
