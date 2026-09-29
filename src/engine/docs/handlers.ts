import { copyFileSync } from 'node:fs'
import { templateInfos } from '../../../templates/resume'
import type { ResumeContent } from '../../shared/domain'
import { json } from '../core/db'
import { AppError } from '../core/errors'
import type { Ctx } from '../engine'
import { loadProfile } from '../profile/store'
import type { Services } from '../services'
import { resumeAsText, reviewPrompt } from './letter'
import { resumeHtml } from './render'
import { styleCheck } from './styleguard'
import {
  defaultTemplate,
  deleteResume,
  exportResume,
  extrasFor,
  insertResume,
  letterDetail,
  listResumes,
  renderLetter,
  renderResume,
  resumeAts,
  resumeDetail,
  resumeRow,
  updateResume,
} from './store'
import { baseContent } from './tailor'
import { refreshGates } from '../packages/store'

export function registerDocumentHandlers(ctx: Ctx, s: Services): void {
  const { router, db } = ctx
  const changed = () => ctx.bus.changed('documents')

  router.on('templates.list', () => templateInfos())
  router.on('resumes.list', ({ kind }) => listResumes(ctx, kind))
  router.on('resumes.get', ({ id }) => resumeDetail(ctx, id))

  router.on('resumes.createBase', ({ name, templateId }) => {
    const { profile } = loadProfile(db)
    if (!profile.work.length) throw new AppError('NO_PROFILE', 'Add your work history to your profile first.', { permanent: true })
    const d = defaultTemplate(ctx)
    const id = insertResume(ctx, {
      kind: 'base',
      name: name || (listResumes(ctx, 'base').length ? `Base resume ${listResumes(ctx, 'base').length + 1}` : 'Base resume'),
      content: baseContent(profile),
      templateId: templateId ?? d.templateId,
      pageSize: d.pageSize,
    })
    changed()
    return resumeDetail(ctx, id)
  })

  router.on('resumes.update', ({ id, name, content, templateId, pageSize }) => {
    // Lines the user edits are theirs: clear the "reverted" flag on any line whose text changed.
    let next = content as ResumeContent | undefined
    if (next) {
      const before = json.parse<ResumeContent>(resumeRow(ctx, id).content, {} as ResumeContent)
      const oldText = new Map(before.work.flatMap((w) => w.bullets.map((b) => [`${w.workId}:${b.sourceIds.join(',')}`, b.text])))
      next = { ...next, work: next.work.map((w) => ({ ...w, bullets: w.bullets.map((b) => (oldText.get(`${w.workId}:${b.sourceIds.join(',')}`) === b.text ? b : { sourceIds: b.sourceIds, text: b.text })) })) }
    }
    updateResume(ctx, id, { name, content: next, templateId, pageSize })
    for (const p of db.all<{ id: number }>("SELECT id FROM packages WHERE resume_id = ? AND status = 'ready'", [id])) refreshGates(ctx, p.id)
    ctx.bus.changed('packages')
    changed()
    return resumeDetail(ctx, id)
  })

  router.on('resumes.html', ({ id }) => {
    const r = resumeDetail(ctx, id)
    return { html: resumeHtml(ctx, r.content, r.templateId, r.pageSize, extrasFor(loadProfile(db).profile)) }
  })
  router.on('resumes.render', ({ id }) => renderResume(ctx, id))
  router.on('resumes.ats', ({ id }) => resumeAts(ctx, id))
  router.on('resumes.export', async ({ id, format, path }) => ({ path: await exportResume(ctx, id, format, path) }))
  router.on('resumes.delete', ({ id }) => {
    deleteResume(ctx, id)
    changed()
    return null
  })
  router.on('resumes.setDefault', ({ id }) => {
    const r = resumeRow(ctx, id)
    if (r.kind !== 'base') throw new AppError('NOT_BASE', 'Only a base resume can be the default.', { permanent: true })
    db.run('UPDATE hunts SET base_resume_id = ? WHERE base_resume_id IS NULL', [id])
    ctx.bus.changed('hunts')
    return null
  })

  router.on('resumes.critique', async ({ id }) => {
    const r = resumeDetail(ctx, id)
    const { profile } = loadProfile(db)
    const job = r.jobId ? db.get<{ title: string; company_name: string; description_md: string }>('SELECT title, company_name, description_md FROM jobs WHERE id = ?', [r.jobId]) : null
    const { issues } = await s.ai.structured(
      reviewPrompt,
      { profile, resumeText: resumeAsText(r.content), job: job ? { title: job.title, company: job.company_name, description: job.description_md } : { title: 'General review', company: 'no specific employer', description: 'Review the resume on its own: clarity, results, and specific wording.' } },
      { task: 'Review resume' },
    )
    db.run('UPDATE resumes SET review = ? WHERE id = ?', [JSON.stringify(issues), id])
    changed()
    return issues
  })

  router.on('letters.get', ({ id }) => letterDetail(ctx, id))
  router.on('letters.update', ({ id, body }) => {
    letterDetail(ctx, id)
    db.run('UPDATE cover_letters SET body = ?, style = ?, pdf_path = NULL, updated_at = ? WHERE id = ?', [body, JSON.stringify(styleCheck(body, 'letter')), ctx.now(), id])
    // The letter's style check is one of its package's gates.
    for (const p of db.all<{ id: number }>("SELECT id FROM packages WHERE cover_letter_id = ? AND status = 'ready'", [id])) refreshGates(ctx, p.id)
    ctx.bus.changed('packages')
    changed()
    return letterDetail(ctx, id)
  })
  router.on('letters.export', async ({ id, path }) => {
    const pdf = await renderLetter(ctx, id, defaultTemplate(ctx).pageSize)
    copyFileSync(pdf, path)
    return { path }
  })
}
