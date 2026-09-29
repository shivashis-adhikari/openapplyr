import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>

const SECRET_KEY = /(api[-_]?key|token|secret|password|passphrase|authorization|cookie|credential)/i
const SECRET_VALUE = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
]

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (typeof value === 'string') {
    let s = value
    for (const re of SECRET_VALUE) s = s.replace(re, '[redacted]')
    return s.length > 4000 ? `${s.slice(0, 4000)}…[${s.length - 4000} more chars]` : s
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? '') }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
    return out
  }
  return value
}

/** JSON-lines logger, one file per day, seven days kept. Secrets are redacted before writing. */
export function createLogger(dir: string, opts: { echo?: boolean; keepDays?: number } = {}): Logger {
  mkdirSync(dir, { recursive: true })
  const keep = opts.keepDays ?? 7
  try {
    const files = readdirSync(dir)
      .filter((f) => /^engine-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true })
  } catch {
    /* pruning is best effort */
  }
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const at = new Date()
    const line = JSON.stringify({ at: at.toISOString(), level, msg: redact(msg), ...(fields ? { fields: redact(fields) } : {}) })
    try {
      appendFileSync(join(dir, `engine-${at.toISOString().slice(0, 10)}.log`), `${line}\n`)
    } catch {
      /* disk full: logging must never crash the engine */
    }
    if (opts.echo && level !== 'debug') console.error(line)
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
