import type { TemplateInfo } from '../../src/shared/domain'
import { cvEu, india, ledger, studio } from './more'
import type { ResumeTemplate } from './shared'
import { classic, compact, modern, technical } from './single'

export const TEMPLATES: ResumeTemplate[] = [classic, modern, compact, technical, studio, ledger, cvEu, india]

export function templateById(id: string): ResumeTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? classic
}

export function templateInfos(): TemplateInfo[] {
  return TEMPLATES.map(({ render: _render, ...info }) => info)
}

/** Paper size and default template by region. */
export function regionDefaults(region: string): { pageSize: 'Letter' | 'A4'; template: string } {
  if (region === 'US' || region === 'CA') return { pageSize: 'Letter', template: 'classic' }
  if (region === 'IN') return { pageSize: 'A4', template: 'india' }
  if (region === 'UK' || region === 'EU') return { pageSize: 'A4', template: 'cv-eu' }
  return { pageSize: 'A4', template: 'modern' }
}

export type { ResumeTemplate, TemplateContext, TemplateExtras } from './shared'
