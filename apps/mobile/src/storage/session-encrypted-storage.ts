import { base64ToBytes, bytesToBase64 } from '@falcondeck/client-core'
import { gcm } from '@noble/ciphers/aes.js'

const ENCRYPTION_VERSION = 1
const NONCE_BYTES = 12
const encoder = new TextEncoder()
const decoder = new TextDecoder()
let sessionStorageKey: Uint8Array | null = null

export type SessionEncryptedValue = {
  encryptionVersion: typeof ENCRYPTION_VERSION
  nonce: string
  ciphertext: string
}

export function setSessionStorageEncryptionKey(dataKey: Uint8Array | null): void {
  sessionStorageKey?.fill(0)
  sessionStorageKey = dataKey ? new Uint8Array(dataKey) : null
}

export function encryptSessionValue(value: unknown): SessionEncryptedValue | null {
  if (!sessionStorageKey) return null
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = gcm(sessionStorageKey, nonce).encrypt(
    encoder.encode(JSON.stringify(value)),
  )
  return {
    encryptionVersion: ENCRYPTION_VERSION,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

export function decryptSessionValue(value: unknown): unknown | null {
  if (
    !sessionStorageKey ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('encryptionVersion' in value) ||
    value.encryptionVersion !== ENCRYPTION_VERSION ||
    !('nonce' in value) ||
    typeof value.nonce !== 'string' ||
    !('ciphertext' in value) ||
    typeof value.ciphertext !== 'string'
  ) {
    return null
  }
  try {
    const plaintext = gcm(sessionStorageKey, base64ToBytes(value.nonce))
      .decrypt(base64ToBytes(value.ciphertext))
    return JSON.parse(decoder.decode(plaintext))
  } catch {
    return null
  }
}
