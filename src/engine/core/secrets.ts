import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Db } from './db'

/** AES-256-GCM encrypted secret storage. The key never touches disk in the engine. */
export class Secrets {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Secrets key must be 32 bytes.')
  }

  private seal(plain: string): { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array } {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return { ciphertext, iv, tag: cipher.getAuthTag() }
  }

  put(plain: string): number {
    const s = this.seal(plain)
    return this.db.run('INSERT INTO secrets (ciphertext, iv, tag, created_at) VALUES (?, ?, ?, ?)', [
      s.ciphertext,
      s.iv,
      s.tag,
      Date.now(),
    ]).lastInsertRowid
  }

  set(id: number, plain: string): void {
    const s = this.seal(plain)
    this.db.run('UPDATE secrets SET ciphertext = ?, iv = ?, tag = ? WHERE id = ?', [s.ciphertext, s.iv, s.tag, id])
  }

  /** Stores into an existing slot or creates one; returns the id. */
  upsert(id: number | null | undefined, plain: string): number {
    if (id && this.db.get('SELECT 1 FROM secrets WHERE id = ?', [id])) {
      this.set(id, plain)
      return id
    }
    return this.put(plain)
  }

  get(id: number | null | undefined): string | null {
    if (!id) return null
    const row = this.db.get<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }>(
      'SELECT ciphertext, iv, tag FROM secrets WHERE id = ?',
      [id],
    )
    if (!row) return null
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv)
    decipher.setAuthTag(row.tag)
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
  }

  delete(id: number | null | undefined): void {
    if (id) this.db.run('DELETE FROM secrets WHERE id = ?', [id])
  }
}
