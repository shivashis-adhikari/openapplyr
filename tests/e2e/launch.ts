import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

type Bridge = { openapplyr: { call: (proc: string, input: unknown) => Promise<unknown> } }

/** Launches the built app on a throwaway data folder. The sample workspace gives it a profile and the offline model. */
export async function launch(env: Record<string, string> = { OPENAPPLYR_DEMO: '1' }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'openapplyr-e2e-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, OPENAPPLYR_DATA_DIR: dataDir, ...env } })
  const win = await app.firstWindow()
  await win.waitForSelector('.shell, .onboarding')
  /** Calls the engine the way the interface does. Rejects after 5 seconds so a dead engine fails a poll instead of hanging it. */
  const api = <T>(proc: string, input?: unknown) =>
    win.evaluate(
      ([p, i]) => Promise.race([(globalThis as unknown as Bridge).openapplyr.call(p, i), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]),
      [proc, input] as const,
    ) as Promise<T>
  const close = async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return { app, win, api, close }
}
