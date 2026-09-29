import { json } from '../core/db'
import { errorMessage } from '../core/errors'
import type { Ctx } from '../engine'
import { credentials } from '../integrations'
import { huntQueries } from '../match/hunts'
import { adapterFor } from '../sources/index'
import type { RawPosting } from '../sources/types'
import { type JobMeta, normalizePosting, refreshSignals } from './ingest'

type Row = { id: number; source_id: number | null; source_kind: string; external_id: string; url: string; title: string; company_name: string; location_text: string | null; meta: string; apply_url: string | null }

/**
 * Some sources list jobs without descriptions (Workday, SmartRecruiters, Workable). Fetches the full
 * posting once, before scoring, and re-normalizes. Returns false when details could not be loaded.
 */
export async function ensureDetails(ctx: Ctx, jobId: number, signal?: AbortSignal): Promise<boolean> {
  const j = ctx.db.get<Row>('SELECT id, source_id, source_kind, external_id, url, title, company_name, location_text, meta, apply_url FROM jobs WHERE id = ?', [jobId])
  if (!j) return false
  const meta = json.parse<JobMeta>(j.meta, {} as JobMeta)
  if (!meta.needsDetails) return true
  const src = j.source_id ? ctx.db.get<{ config: string }>('SELECT config FROM sources WHERE id = ?', [j.source_id]) : null
  const adapter = adapterFor(j.source_kind)
  if (!adapter.details || !src) return false
  try {
    const d = await adapter.details({ externalId: j.external_id, url: j.url, meta }, json.parse(src.config, {}), {
      http: ctx.http,
      now: ctx.now(),
      signal,
      queries: huntQueries(ctx.db),
      credentials: credentials(ctx),
    })
    const merged: RawPosting = {
      externalId: j.external_id,
      title: j.title,
      company: j.company_name,
      url: d.url ?? j.url,
      applyUrl: d.applyUrl ?? j.apply_url ?? undefined,
      locationText: d.locationText || j.location_text || '',
      remoteHint: d.remoteHint,
      countryHint: d.countryHint,
      descriptionHtml: d.descriptionHtml,
      descriptionText: d.descriptionText,
      employmentHint: d.employmentHint,
      needsDetails: false,
      meta,
    }
    const n = normalizePosting(merged, j.source_kind)
    ctx.db.run(
      `UPDATE jobs SET description_md = ?, description_html = ?, remote = ?, locations = ?, location_text = ?, employment_type = ?, contract_type = ?,
         salary = COALESCE(?, salary), salary_annual_min = COALESCE(?, salary_annual_min), salary_annual_max = COALESCE(?, salary_annual_max),
         salary_currency = COALESCE(?, salary_currency), url = ?, apply_url = COALESCE(?, apply_url), meta = ?, updated_at = ? WHERE id = ?`,
      [
        n.descriptionMd,
        n.descriptionHtml,
        n.remote,
        JSON.stringify(n.locations),
        n.locationText,
        n.employment,
        n.contract,
        n.salary ? JSON.stringify(n.salary) : null,
        n.annualMin,
        n.annualMax,
        n.salary?.currency ?? null,
        n.url,
        n.applyUrl,
        JSON.stringify({ ...n.meta, needsDetails: false }),
        ctx.now(),
        jobId,
      ],
    )
    refreshSignals(ctx.db, jobId, ctx.now())
    return true
  } catch (err) {
    ctx.log.warn('job details failed', { jobId, err: errorMessage(err) })
    return false
  }
}
