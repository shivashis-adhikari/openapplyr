// The golden path through the built app: paste a posting, prepare it, approve it, check the dry run,
// send it, and see it tracked. The sample workspace supplies the profile and the offline model; the
// form is the local fake ATS, so nothing leaves the machine.
import { expect, test } from '@playwright/test'
import { t } from '../../src/renderer/strings/en'
import { startFakeAts } from '../../tools/fake-ats/server'
import { launch } from './launch'

const POSTING = `Senior Backend Engineer
Company: Acme
Location: Lisbon, Portugal
Acme builds payments software for small shops across Europe. You will design and run the services that move money:
ledgers, payouts and the APIs our merchants call. We work in TypeScript and Go on Postgres and Kafka.
You have five or more years building backend systems, have owned services in production, and care about correctness.`

test('a pasted posting becomes a sent, tracked application', async () => {
  const ats = await startFakeAts()
  const { win, api, close } = await launch()
  try {

    // Not what this test is about: apply in a headless browser, at any hour, with short gaps.
    await api('settings.update', { automation: { headless: true, minGapSeconds: 5, maxGapSeconds: 5, perHostGapSeconds: 10 } })
    const { hunt } = (await api<{ hunt: { config: object } }[]>('hunts.list'))[0]!
    await api('hunts.save', { ...hunt, config: { ...hunt.config, activeHours: { start: '00:00', end: '23:59' } } })

    // 1. Add the job by pasting its text, with the link to its form.
    await win.getByRole('link', { name: t.nav.jobs }).click()
    await win.getByRole('button', { name: t.jobs.importLink }).click()
    const dialog = win.getByRole('dialog')
    await dialog.getByLabel(t.jobs.importLinkLabel).fill(`${ats.url}/greenhouse/jobs/1`)
    await dialog.getByRole('button', { name: t.jobs.importText }).click()
    await dialog.getByLabel(t.jobs.importTextLabel).fill(POSTING)
    await dialog.getByRole('button', { name: t.jobs.add }).click()
    await expect(win.getByRole('heading', { name: 'Senior Backend Engineer' })).toBeVisible()

    // 2. Once it is scored against the hunt, prepare it.
    const jobId = Number(new URLSearchParams(win.url().split('?')[1]).get('job'))
    await expect.poll(async () => (await api<{ scores: unknown[] }>('jobs.get', { id: jobId })).scores.length, { timeout: 60_000 }).toBeGreaterThan(0)
    await win.getByRole('button', { name: t.jobs.prepare }).click()

    // 3. Review the package in the queue and approve it.
    await win.getByRole('link', { name: t.nav.queue }).click()
    const row = win.getByRole('row', { name: /Acme/ })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.click()
    // Approve from the detail pane once it shows this package, not whichever one was open before.
    const detail = win.locator('.detail').filter({ hasText: 'Acme' })
    await detail.getByRole('button', { name: t.queue.approve }).click()

    // 4. The first runs are dry runs: the form is filled and nothing is sent.
    await win.getByRole('link', { name: t.nav.today }).click()
    const item = win.locator('.worklist-item', { hasText: 'Acme' })
    const send = item.getByRole('button', { name: t.applications.sendForReal })
    await expect(send).toBeVisible({ timeout: 120_000 })
    expect(ats.submissions).toHaveLength(0)

    // 5. Send it for real.
    await send.click()
    await expect.poll(() => ats.submissions.length, { timeout: 120_000 }).toBe(1)
    const sent = ats.submissions[0]!
    expect(sent.fields['first_name']).toBe('Maya')
    expect(sent.fields['email']).toBe('maya.okafor@example.com')
    expect(sent.fields['question_3']?.length).toBeGreaterThan(40)
    expect(sent.files.some((f) => f.endsWith('.pdf'))).toBe(true)

    // 6. It is tracked as applied.
    await win.getByRole('link', { name: t.nav.applications }).click()
    await expect.poll(async () => (await api<{ company: string; status: string }[]>('applications.list', {})).find((a) => a.company === 'Acme')?.status, { timeout: 30_000 }).toBe('applied')
  } finally {
    await close()
    await ats.close()
  }
})
