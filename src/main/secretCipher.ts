import type { SecretCipher } from './storage/environmentStore'

/** The subset of Electron's `safeStorage` that is used, so tests can pass a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Never falls back to plain text: when the OS keychain is unavailable both directions throw. */
export function createSecretCipher(safeStorage: SafeStorageLike): SecretCipher {
  const check = (): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption_unavailable')
  }
  return {
    encrypt(plain) {
      check()
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(cipher) {
      check()
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    },
  }
}
