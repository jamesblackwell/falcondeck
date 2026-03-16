import nacl from 'tweetnacl'

import type {
  EncryptedEnvelope,
  SessionKeyMaterial,
  WrappedDataKey,
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const AES_NONCE_BYTES = 12
const BOX_PUBLIC_KEY_BYTES = 32
const BOX_NONCE_BYTES = 24
const DATA_KEY_BYTES = 32
const CONTENT_VERSION = 0
const WRAPPED_KEY_VERSION = 0

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function concatBytes(...arrays: Uint8Array[]) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  arrays.forEach((array) => {
    merged.set(array, offset)
    offset += array.length
  })
  return merged
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function ensureVariant(variant: string) {
  if (variant !== 'data_key_v1') {
    throw new Error(`Unsupported encryption variant: ${variant}`)
  }
}

function ensureContentBundle(bundle: Uint8Array) {
  if (bundle.length < 1 + AES_NONCE_BYTES + 16) {
    throw new Error('Encrypted payload is malformed')
  }
  if (bundle[0] !== CONTENT_VERSION) {
    throw new Error('Unsupported encrypted payload version')
  }
}

function ensureWrappedBundle(bundle: Uint8Array) {
  if (bundle.length < 1 + BOX_PUBLIC_KEY_BYTES + BOX_NONCE_BYTES + 16) {
    throw new Error('Wrapped key payload is malformed')
  }
  if (bundle[0] !== WRAPPED_KEY_VERSION) {
    throw new Error('Unsupported wrapped key version')
  }
}

async function importAesKey(dataKey: Uint8Array) {
  const rawKey = dataKey.buffer.slice(dataKey.byteOffset, dataKey.byteOffset + dataKey.byteLength) as ArrayBuffer
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export type BoxKeyPair = ReturnType<typeof nacl.box.keyPair>

export type SessionCryptoState = {
  dataKey: Uint8Array
  material: SessionKeyMaterial | null
}

export function generateBoxKeyPair() {
  return nacl.box.keyPair()
}

export function publicKeyToBase64(keyPair: BoxKeyPair) {
  return bytesToBase64(keyPair.publicKey)
}

export function secretKeyToBase64(keyPair: BoxKeyPair) {
  return bytesToBase64(keyPair.secretKey)
}

export function restoreBoxKeyPair(secretKeyBase64: string): BoxKeyPair {
  const secretKey = base64ToBytes(secretKeyBase64)
  if (secretKey.length !== BOX_PUBLIC_KEY_BYTES) {
    throw new Error('Stored secret key has invalid length')
  }
  return nacl.box.keyPair.fromSecretKey(secretKey)
}

export async function encryptJson(dataKey: Uint8Array, value: unknown): Promise<EncryptedEnvelope> {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new Error('Data key must be 32 bytes')
  }
  const nonce = randomBytes(AES_NONCE_BYTES)
  const key = await importAesKey(dataKey)
  const plaintext = encoder.encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext)
  const bundle = concatBytes(new Uint8Array([CONTENT_VERSION]), nonce, new Uint8Array(ciphertext))
  return {
    encryption_variant: 'data_key_v1',
    ciphertext: bytesToBase64(bundle),
  }
}

export async function decryptJson<T>(dataKey: Uint8Array, envelope: EncryptedEnvelope): Promise<T> {
  ensureVariant(envelope.encryption_variant)
  const bundle = base64ToBytes(envelope.ciphertext)
  ensureContentBundle(bundle)
  const nonce = bundle.slice(1, 1 + AES_NONCE_BYTES)
  const ciphertext = bundle.slice(1 + AES_NONCE_BYTES)
  const key = await importAesKey(dataKey)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext)
  return JSON.parse(decoder.decode(plaintext)) as T
}

export function unwrapDataKey(keyPair: BoxKeyPair, wrapped: WrappedDataKey) {
  ensureVariant(wrapped.encryption_variant)
  const bundle = base64ToBytes(wrapped.wrapped_key)
  ensureWrappedBundle(bundle)
  const ephemeralPublicKey = bundle.slice(1, 1 + BOX_PUBLIC_KEY_BYTES)
  const nonce = bundle.slice(1 + BOX_PUBLIC_KEY_BYTES, 1 + BOX_PUBLIC_KEY_BYTES + BOX_NONCE_BYTES)
  const ciphertext = bundle.slice(1 + BOX_PUBLIC_KEY_BYTES + BOX_NONCE_BYTES)
  const opened = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, keyPair.secretKey)
  if (!opened) {
    throw new Error('Failed to unwrap encrypted data key')
  }
  if (opened.length !== DATA_KEY_BYTES) {
    throw new Error('Wrapped data key has invalid length')
  }
  return opened
}

export function bootstrapSessionCrypto(keyPair: BoxKeyPair, material: SessionKeyMaterial): SessionCryptoState {
  ensureVariant(material.encryption_variant)
  const localPublicKey = publicKeyToBase64(keyPair)
  if (material.client_public_key !== localPublicKey) {
    throw new Error('Encrypted session bootstrap is not addressed to this client')
  }
  const dataKey = unwrapDataKey(keyPair, material.client_wrapped_data_key)
  return { dataKey, material }
}
