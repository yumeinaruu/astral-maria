import { describe, expect, it } from 'vitest'
import { createSecretCipher, type SafeStorageLike } from '../../src/main/secretCipher'

function fakeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
  }
}

describe('createSecretCipher', () => {
  it('round-trips through base64 of the encrypted bytes', () => {
    const cipher = createSecretCipher(fakeStorage(true))
    const encrypted = cipher.encrypt('s3cret')
    expect(encrypted).toBe(Buffer.from('enc:s3cret').toString('base64'))
    expect(encrypted).not.toContain('s3cret')
    expect(cipher.decrypt(encrypted)).toBe('s3cret')
  })

  it('throws encryption_unavailable in both directions instead of storing plain text', () => {
    const cipher = createSecretCipher(fakeStorage(false))
    expect(() => cipher.encrypt('x')).toThrow('encryption_unavailable')
    expect(() => cipher.decrypt('eA==')).toThrow('encryption_unavailable')
  })
})
