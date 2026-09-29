import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Db } from './db'
import { Bus } from './events'
import { Http } from './http'
import { redact } from './log'
import { Secrets } from './secrets'
import { SettingsStore } from './settings'

function memDb(): Db {
  const db = new Db(':memory:')
  db.migrate()
  return db
}

describe('Db', () => {
  it('binds whole numbers as integers, so text built from them has no ".0"', () => {
    const db = new Db(':memory:')
    expect(db.get("SELECT 'job:' || ? v, typeof(?) t, typeof(?) r", [2, 2, 2.5])).toEqual({ v: 'job:2', t: 'integer', r: 'real' })
    expect(db.get("SELECT 'job:' || :id v", { id: 7 })).toEqual({ v: 'job:7' })
  })

  it('binds only the named parameters a statement uses', () => {
    const db = new Db(':memory:')
    const shared = { a: 1, b: 2, ab: 3 }
    expect(db.get('SELECT :a + :ab AS n', shared)).toEqual({ n: 4 })
    expect(db.get('SELECT :b AS n', shared)).toEqual({ n: 2 })
    // node:sqlite binds a name the object lacks as NULL.
    expect(db.get('SELECT :c AS n', shared)).toEqual({ n: null })
  })

  it('migrates to the latest version and is idempotent', () => {
    const db = memDb()
    const v = db.get<{ user_version: number }>('PRAGMA user_version')!.user_version
    expect(v).toBeGreaterThan(0)
    db.migrate()
    expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(v)
  })

  it('rolls back a failed transaction and keeps an outer one when an inner savepoint fails', () => {
    const db = memDb()
    const put = (k: string) => db.run("INSERT INTO settings (key, value) VALUES (?, '1')", [k])
    expect(() =>
      db.tx(() => {
        put('a')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.get('SELECT 1 FROM settings WHERE key = ?', ['a'])).toBeUndefined()

    db.tx(() => {
      put('outer')
      try {
        db.tx(() => {
          put('inner')
          throw new Error('inner failure')
        })
      } catch {
        /* expected */
      }
    })
    expect(db.get('SELECT 1 x FROM settings WHERE key = ?', ['outer'])).toBeTruthy()
    expect(db.get('SELECT 1 x FROM settings WHERE key = ?', ['inner'])).toBeUndefined()
  })

  it('allows only one live application per job group (duplicate protection)', () => {
    const db = memDb()
    const add = (archived: number) =>
      db.run(
        `INSERT INTO applications (group_key, company_name, title, status, archived, last_activity_at, created_at)
         VALUES ('job:1', 'Acme', 'Engineer', 'applied', ?, 0, 0)`,
        [archived],
      )
    add(0)
    expect(() => add(0)).toThrow(/UNIQUE/)
    db.run("UPDATE applications SET archived = 1 WHERE group_key = 'job:1'")
    expect(() => add(0)).not.toThrow()
  })

  it('keeps full-text search in sync with job rows', () => {
    const db = memDb()
    const now = Date.now()
    const id = db.run(
      `INSERT INTO jobs (source_kind, external_id, company_name, title, title_norm, url, description_md, first_seen_at, last_seen_at, hash, updated_at)
       VALUES ('greenhouse', 'x1', 'Acme', 'Backend Engineer', 'backend engineer', 'https://x', 'We use PostgreSQL and Kubernetes', ?, ?, 'h', ?)`,
      [now, now, now],
    ).lastInsertRowid
    const hit = () => db.all<{ rowid: number }>("SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH 'kubernetes'")
    expect(hit().map((r) => r.rowid)).toEqual([id])
    db.run("UPDATE jobs SET description_md = 'Only Go here' WHERE id = ?", [id])
    expect(hit()).toEqual([])
    db.run('DELETE FROM jobs WHERE id = ?', [id])
    expect(db.all("SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH 'go'")).toEqual([])
  })

  it('rejects unsupported parameter types instead of silently storing garbage', () => {
    const db = memDb()
    expect(() => db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['k', { a: 1 }])).toThrow(/Unsupported/)
  })
})

describe('Secrets', () => {
  it('round-trips and fails closed on tampering or a wrong key', () => {
    const db = memDb()
    const key = randomBytes(32)
    const s = new Secrets(db, key)
    const id = s.put('sk-live-abc')
    expect(s.get(id)).toBe('sk-live-abc')
    s.set(id, 'changed')
    expect(s.get(id)).toBe('changed')
    expect(() => new Secrets(db, randomBytes(32)).get(id)).toThrow()
    db.run('UPDATE secrets SET ciphertext = ? WHERE id = ?', [new Uint8Array([1, 2, 3]), id])
    expect(() => s.get(id)).toThrow()
    expect(s.get(9999)).toBeNull()
  })
})

describe('SettingsStore', () => {
  it('fills defaults, merges nested patches, and survives corrupt stored JSON', () => {
    const db = memDb()
    const s = new SettingsStore(db, new Bus(0))
    expect(s.get().budget.daily).toBe(3)
    const next = s.update({ budget: { daily: 5 } })
    expect(next.budget).toEqual({ daily: 5, monthly: 40 })
    db.run("UPDATE settings SET value = '{not json' WHERE key = 'app'")
    const fresh = new SettingsStore(db, new Bus(0))
    expect(fresh.get().budget.daily).toBe(3)
    expect(() => s.update({ budget: { daily: -1 } })).toThrow()
  })
})

describe('redact', () => {
  it('removes secrets by key name and by value pattern', () => {
    const out = redact({ apiKey: 'x', nested: { authorization: 'Bearer abc.def.ghi' }, msg: 'failed with sk-ant-api03-ABCDEFGHIJKLMNOP' }) as Record<
      string,
      unknown
    >
    expect(out['apiKey']).toBe('[redacted]')
    expect((out['nested'] as Record<string, unknown>)['authorization']).toBe('[redacted]')
    expect(out['msg']).toBe('failed with [redacted]')
  })
})

describe('Http', () => {
  async function server(handler: (n: number) => { status: number; body: string; headers?: Record<string, string> }) {
    let n = 0
    const srv = createServer((_req, res) => {
      const r = handler(++n)
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers })
      res.end(r.body)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
    return { url, close: () => new Promise<void>((r) => srv.close(() => r())), count: () => n }
  }

  it('retries 503 then succeeds, and honors Retry-After', async () => {
    const s = await server((n) => (n < 2 ? { status: 503, body: '', headers: { 'retry-after': '0' } } : { status: 200, body: '{"ok":true}' }))
    const http = new Http('test', 100)
    await expect(http.getJson(s.url)).resolves.toEqual({ ok: true })
    expect(s.count()).toBe(2)
    await s.close()
  })

  it('does not retry a 404 and reports it clearly', async () => {
    const s = await server(() => ({ status: 404, body: 'nope' }))
    const http = new Http('test', 100)
    await expect(http.getJson(s.url)).rejects.toThrow(/returned 404/)
    expect(s.count()).toBe(1)
    await s.close()
  })

  it('caps response size', async () => {
    const s = await server(() => ({ status: 200, body: 'x'.repeat(2048) }))
    const http = new Http('test', 100)
    await expect(http.request(s.url, { maxBytes: 1024 })).rejects.toThrow(/more than/)
    await s.close()
  })

  it('refuses non-web URLs', async () => {
    await expect(new Http('t').request('file:///etc/passwd')).rejects.toThrow(/Not a web address/)
  })
})
