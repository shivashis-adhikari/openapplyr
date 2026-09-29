// Runs a Node CLI inside Electron's bundled Node, so tests exercise the same runtime
// (and the same SQLite build with FTS5) that ships in the app.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const electron = createRequire(import.meta.url)('electron')
const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
