import { describe, expect, it } from 'vitest'
import { testCtx } from '../test/harness'
import { canMove, createApplication, setStatus } from './applications'
import { MIN_GROUP, analytics } from './analytics'
import { exportApplications, guessMapping, importApplications, mapStatus, parseDate, previewImport } from './csv'

describe('status machine', () => {
  it('lets automatic sources move forward only, and the user anywhere', () => {
    expect(canMove('applied', 'interviewing', 'mail')).toBe(true)
    expect(canMove('interviewing', 'screening', 'mail')).toBe(false)
    expect(canMove('interviewing', 'screening', 'user')).toBe(true)
    expect(canMove('offer', 'rejected', 'mail')).toBe(true)
    expect(canMove('accepted', 'rejected', 'mail')).toBe(false)
    expect(canMove('rejected', 'interviewing', 'mail')).toBe(false)
    expect(canMove('queued', 'rejected', 'mail')).toBe(false)
    expect(canMove('applied', 'ghosted', 'rule')).toBe(true)
    // Ghosted is reversible: a reply moves it on.
    expect(canMove('ghosted', 'screening', 'mail')).toBe(true)
    expect(canMove('applied_unverified', 'applied', 'mail')).toBe(true)
  })

  it('records every change as an event and stamps the applied date once', () => {
    const ctx = testCtx()
    const id = createApplication(ctx.db, { jobId: null, groupKey: 'manual:acme:backend', companyId: null, company: 'Acme', title: 'Backend Engineer', huntId: null, packageId: null, status: 'queued', channel: 'other', url: null, source: 'user' }, 1000)
    expect(setStatus(ctx.db, id, 'applied', 'user', {}, 2000)).toBe(true)
    expect(setStatus(ctx.db, id, 'screening', 'mail', { messageId: 7 }, 3000)).toBe(true)
    expect(setStatus(ctx.db, id, 'applied', 'mail', {}, 4000)).toBe(false)
    const app = ctx.db.get<{ status: string; applied_at: number }>('SELECT status, applied_at FROM applications WHERE id = ?', [id])!
    expect(app).toEqual({ status: 'screening', applied_at: 2000 })
    const events = ctx.db.all<{ type: string; source: string; data: string }>('SELECT type, source, data FROM events WHERE application_id = ? ORDER BY id', [id])
    expect(events.map((e) => `${e.type}:${e.source}`)).toEqual(['created:user', 'status:user', 'status:mail'])
    expect(JSON.parse(events[2]!.data)).toMatchObject({ from: 'applied', to: 'screening', messageId: 7 })
    expect(() => createApplication(ctx.db, { jobId: null, groupKey: 'manual:acme:backend', companyId: null, company: 'Acme', title: 'Backend Engineer', huntId: null, packageId: null, status: 'queued', channel: 'other', url: null, source: 'user' }, 5000)).toThrow(/already have/)
  })
})

describe('import and export', () => {
  const huntr = 'Company,Job Title,List,Date Applied,Job URL,Notes\r\nAcme,Backend Engineer,Applied,2026-08-01,https://acme.example/1,Referred by Ana\r\nGlobex,Data Engineer,Interview,03/09/2026,,\r\nInitech,Platform Engineer,Wishlist,,,\r\n=HYPERLINK("x"),Title,Applied,,,\r\n'

  it('guesses columns and maps other trackers\' stages', () => {
    const p = previewImport(huntr)
    expect(p.mapping).toEqual({ company: 'Company', title: 'Job Title', status: 'List', appliedAt: 'Date Applied', url: 'Job URL', notes: 'Notes' })
    expect(p.rows).toBe(4)
    expect(guessMapping(['Position', 'Employer', 'Stage'])).toEqual({ title: 'Position', company: 'Employer', status: 'Stage' })
    expect(['Wishlist', 'Phone screen', 'Onsite', 'Offer accepted', 'Not selected', ''].map(mapStatus)).toEqual(['skip', 'screening', 'interviewing', 'accepted', 'rejected', 'applied'])
    expect(new Date(parseDate('03/09/2026', true)!).getMonth()).toBe(2)
    expect(new Date(parseDate('03/09/2026', false)!).getMonth()).toBe(8)
    expect(new Date(parseDate('25/09/2026', true)!).getDate()).toBe(25)
  })

  it('imports once, skips saved-only rows and duplicates, and exports without formula injection', () => {
    const ctx = testCtx()
    const r = importApplications(ctx.db, huntr, previewImport(huntr).mapping, Date.UTC(2026, 8, 28), true)
    expect(r).toMatchObject({ imported: 3, skipped: 1, duplicates: 0 })
    expect(importApplications(ctx.db, huntr, previewImport(huntr).mapping, Date.UTC(2026, 8, 28), true)).toMatchObject({ imported: 0, duplicates: 3 })
    expect(ctx.db.get<{ status: string }>("SELECT status FROM applications WHERE company_name = 'Globex'")!.status).toBe('interviewing')
    const csv = exportApplications(ctx.db, 'csv')
    expect(csv).toContain("'=HYPERLINK")
    expect(JSON.parse(exportApplications(ctx.db, 'json'))).toHaveLength(3)
  })
})

describe('analytics', () => {
  it('counts responses from events, and compares groups only when both have enough applications', () => {
    const ctx = testCtx()
    const day = 86_400_000
    const now = Date.UTC(2026, 8, 28)
    const src = ctx.db.run("INSERT INTO sources (kind, key, label, config, created_at) VALUES ('remotive', 'd', 'x', '{}', 0)").lastInsertRowid
    for (let i = 0; i < 2 * MIN_GROUP; i++) {
      const early = i < MIN_GROUP
      const posted = now - 40 * day
      const jobId = ctx.db.run(
        "INSERT INTO jobs (source_id, source_kind, external_id, company_name, title, title_norm, url, description_md, posted_at, first_seen_at, last_seen_at, hash, updated_at) VALUES (?, 'remotive', ?, 'Co', 'Backend Engineer', 'backend engineer', 'https://x', '', ?, 0, 0, 'h', 0)",
        [src, `j${i}`, posted],
      ).lastInsertRowid
      const appliedAt = posted + (early ? 1 : 10) * day
      const id = createApplication(ctx.db, { jobId, groupKey: `job:${jobId}`, companyId: null, company: 'Co', title: 'Backend Engineer', huntId: null, packageId: null, status: 'applied', channel: 'ats', url: null, appliedAt, source: 'app' }, appliedAt)
      // Early applications: half get a screen. Late ones: one in ten.
      if ((early && i % 2 === 0) || (!early && i % 10 === 0)) setStatus(ctx.db, id, 'screening', 'mail', {}, appliedAt + 5 * day)
    }
    const a = analytics(ctx.db, null, now)
    expect(a).toMatchObject({ applied: 40, responded: 12, screen: 12, interview: 0, medianDaysToResponse: 5 })
    expect(a.byDaysAfterPosting.find((g) => g.key === '0 to 3 days')).toMatchObject({ applied: 20, responded: 10 })
    expect(a.notes[0]).toMatch(/within 3 days of posting got a response 50% \(10 of 20\); later ones 10% \(2 of 20\)/)
    // With fewer than the minimum per group, no comparison is made.
    ctx.db.run('DELETE FROM applications WHERE id > 30')
    expect(analytics(ctx.db, null, now).notes).toEqual([])
  })
})
