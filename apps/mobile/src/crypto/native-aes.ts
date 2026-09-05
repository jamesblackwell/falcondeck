import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from 'expo-crypto'
import { setAesGcmBackend, type AesGcmBackend } from '@falcondeck/client-core'

// Expo executes these AES operations asynchronously in native code. Hermes
// otherwise takes client-core's synchronous JS fallback even though the
// public encrypt/decrypt functions return promises.
export function installNativeAes(): void {
  const keys = new WeakMap<Uint8Array, Promise<AESEncryptionKey>>()
  function importKey(bytes: Uint8Array): Promise<AESEncryptionKey> {
    const cached = keys.get(bytes)
    if (cached) return cached
    const imported = AESEncryptionKey.import(new Uint8Array(bytes)).catch((error: unknown) => {
      if (keys.get(bytes) === imported) keys.delete(bytes)
      throw error
    })
    keys.set(bytes, imported)
    return imported
  }
  const backend: AesGcmBackend = {
    async encrypt(bytes, nonce, plaintext) {
      const sealed = await aesEncryptAsync(plaintext, await importKey(bytes), {
        nonce: { bytes: nonce },
      })
      return sealed.ciphertext({ includeTag: true })
    },
    async decrypt(bytes, nonce, ciphertext) {
      const key = await importKey(bytes)
      return aesDecryptAsync(AESSealedData.fromParts(nonce, ciphertext, 16), key)
    },
    forgetKey(bytes) {
      keys.delete(bytes)
    },
  }
  setAesGcmBackend(backend)
}
