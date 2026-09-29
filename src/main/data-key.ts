import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The data key encrypts every secret the engine stores (API keys, mail passwords, ATS passwords).
 * It is generated once and kept on disk encrypted by the OS keychain (Keychain, DPAPI, libsecret).
 * When Linux has no keyring, safeStorage falls back to a hardcoded key, so we require a passphrase instead.
 */
export type DataKeyState = { kind: 'ready'; key: Buffer } | { kind: 'needs-passphrase'; firstRun: boolean }

const KEY_FILE = 'data.key'
const PASS_SALT_FILE = 'data.salt'
const PASS_CHECK_FILE = 'data.check'
const CHECK_TEXT = 'openapplyr-passphrase-check'

export function keychainIsWeak(): boolean {
  return process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
}

export function loadDataKey(dataDir: string): DataKeyState {
  if (keychainIsWeak() || !safeStorage.isEncryptionAvailable()) {
    return { kind: 'needs-passphrase', firstRun: !existsSync(join(dataDir, PASS_SALT_FILE)) }
  }
  const file = join(dataDir, KEY_FILE)
  if (existsSync(file)) {
    const key = Buffer.from(safeStorage.decryptString(readFileSync(file)), 'base64')
    if (key.length !== 32) throw new Error('The stored data key is corrupt.')
    return { kind: 'ready', key }
  }
  const key = randomBytes(32)
  writeFileSync(file, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 })
  return { kind: 'ready', key }
}

/** Derives the data key from a passphrase (Linux without a keyring). */
export function keyFromPassphrase(dataDir: string, passphrase: string): Buffer {
  const saltFile = join(dataDir, PASS_SALT_FILE)
  let salt: Buffer
  if (existsSync(saltFile)) salt = readFileSync(saltFile)
  else {
    salt = randomBytes(16)
    writeFileSync(saltFile, salt, { mode: 0o600 })
  }
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

/**
 * True when the key matches the one the data was first protected with. The first call stores an
 * encrypted check value; later calls decrypt it. A wrong passphrase is rejected before any secret is
 * read or written with it.
 */
export function passphraseKeyMatches(dataDir: string, key: Buffer): boolean {
  const file = join(dataDir, PASS_CHECK_FILE)
  if (!existsSync(file)) {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(CHECK_TEXT, 'utf8'), c.final()])
    writeFileSync(file, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 })
    return true
  }
  const raw = readFileSync(file)
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8') === CHECK_TEXT
  } catch {
    return false
  }
}
