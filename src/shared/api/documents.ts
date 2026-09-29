import { z } from 'zod'
import type { ResumeDetail, ResumeSummary, ReviewIssue, StyleIssue, TemplateInfo } from '../domain'
import { proc } from './define'

export type AtsCheck = { label: string; ok: boolean; detail: string }
export type AtsReport = { text: string; checks: AtsCheck[]; bytes: number }
export type LetterDetail = { id: number; jobId: number | null; body: string; issues: StyleIssue[]; pdfPath: string | null; templateId: string; updatedAt: number }

const Line = z.object({ sourceIds: z.array(z.string()), text: z.string().min(1).max(600), flagged: z.string().optional() })
export const ResumeContentSchema = z.object({
  name: z.string(),
  headline: z.string(),
  contact: z.object({ email: z.string(), phone: z.string(), location: z.string(), links: z.array(z.object({ label: z.string(), url: z.string() })) }),
  summary: z.object({ text: z.string(), factIds: z.array(z.string()) }),
  work: z.array(
    z.object({ workId: z.string(), company: z.string(), title: z.string(), location: z.string(), start: z.string(), end: z.string().nullable(), bullets: z.array(Line) }),
  ),
  education: z.array(z.object({ id: z.string(), institution: z.string(), degree: z.string(), field: z.string(), start: z.string(), end: z.string(), grade: z.string() })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), bullets: z.array(Line) })),
  skills: z.array(z.string()),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string(), date: z.string() })),
  languages: z.array(z.object({ name: z.string(), fluency: z.string() })),
})

const Id = z.object({ id: z.number().int() })

export const documentsApi = {
  'resumes.list': proc<ResumeSummary[]>()(z.object({ kind: z.enum(['all', 'base', 'tailored']).default('all') })),
  'resumes.get': proc<ResumeDetail>()(Id),
  'resumes.createBase': proc<ResumeDetail>()(z.object({ name: z.string().trim().max(80).optional(), templateId: z.string().optional() })),
  'resumes.update': proc<ResumeDetail>()(
    z.object({ id: z.number().int(), name: z.string().trim().min(1).max(80).optional(), content: ResumeContentSchema.optional(), templateId: z.string().optional(), pageSize: z.enum(['Letter', 'A4']).optional() }),
  ),
  'resumes.html': proc<{ html: string }>()(Id),
  'resumes.render': proc<{ pdfPath: string; docxPath: string }>()(Id),
  'resumes.ats': proc<AtsReport>()(Id),
  'resumes.export': proc<{ path: string }>()(z.object({ id: z.number().int(), format: z.enum(['pdf', 'docx', 'txt']), path: z.string().min(1) })),
  'resumes.critique': proc<ReviewIssue[]>()(Id),
  'resumes.delete': proc<null>()(Id),
  'resumes.setDefault': proc<null>()(Id),
  'templates.list': proc<TemplateInfo[]>()(z.void()),
  'letters.get': proc<LetterDetail>()(Id),
  'letters.update': proc<LetterDetail>()(z.object({ id: z.number().int(), body: z.string().min(1).max(10_000) })),
  'letters.export': proc<{ path: string }>()(z.object({ id: z.number().int(), path: z.string().min(1) })),
}
