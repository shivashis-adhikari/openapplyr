import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { keyFromPassphrase, passphraseKeyMatches } from './data-key'

it('accepts the passphrase the data was protected with and rejects any other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapplyr-key-'))
  expect(passphraseKeyMatches(dir, keyFromPassphrase(dir, 'correct horse battery'))).toBe(true)
  expect(passphraseKeyMatches(dir, keyFromPassphrase(dir, 'correct horse battery'))).toBe(true)
  expect(passphraseKeyMatches(dir, keyFromPassphrase(dir, 'correct horse batterie'))).toBe(false)
})
