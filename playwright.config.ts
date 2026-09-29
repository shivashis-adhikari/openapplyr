import { defineConfig } from '@playwright/test'

// End-to-end runs launch the built app (npm run e2e builds first), one at a time.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 5 * 60_000,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
})
