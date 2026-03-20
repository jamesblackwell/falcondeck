import nacl from 'tweetnacl'
import { gcm } from '@noble/ciphers/aes.js'

import type {
  EncryptedEnvelope,
  PairingPublicKeyBundle,
  SessionKeyMaterial,
  WrappedDataKey,
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const AES_NONCE_BYTES = 12
const BOX_PUBLIC_KEY_BYTES = 32
const BOX_NONCE_BYTES = 24
const DATA_KEY_BYTES = 32
const SIGNING_PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const CONTENT_VERSION = 0
const WRAPPED_KEY_VERSION = 0

function getWebCrypto() {
  const webCrypto = globalThis.crypto
  if (!webCrypto) {
    throw new Error('Web Crypto is not available in this runtime')
  }
  return webCrypto
}

function getSubtleCrypto() {
  const subtle = getWebCrypto().subtle
  if (!subtle) {
    throw new Error('Web Crypto subtle API is not available in this runtime')
  }
  return subtle
}

function hasSubtleCrypto() {
  return typeof globalThis.crypto?.subtle !== 'undefined'
}

function toArrayBuffer(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes.byteLength)
  copied.set(bytes)
  return copied.buffer
}

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
  getWebCrypto().getRandomValues(bytes)
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
  const rawKey = toArrayBuffer(dataKey)
  return getSubtleCrypto().importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptAesGcm(dataKey: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array) {
  if (hasSubtleCrypto()) {
    const key = await importAesKey(dataKey)
    return new Uint8Array(
      await getSubtleCrypto().encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
        key,
        toArrayBuffer(plaintext),
      ),
    )
  }

  return gcm(dataKey, nonce).encrypt(plaintext)
}

async function decryptAesGcm(dataKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) {
  if (hasSubtleCrypto()) {
    const key = await importAesKey(dataKey)
    return new Uint8Array(
      await getSubtleCrypto().decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
        key,
        toArrayBuffer(ciphertext),
      ),
    )
  }

  return gcm(dataKey, nonce).decrypt(ciphertext)
}

export type BoxKeyPair = ReturnType<typeof nacl.box.keyPair>
export type IdentityKeyPair = ReturnType<typeof nacl.sign.keyPair.fromSeed>

export type SessionCryptoState = {
  dataKey: Uint8Array
  material: SessionKeyMaterial | null
}

export function generateBoxKeyPair() {
  return nacl.box.keyPair.fromSecretKey(randomBytes(BOX_PUBLIC_KEY_BYTES))
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

export function deriveIdentityKeyPair(keyPair: BoxKeyPair): IdentityKeyPair {
  return nacl.sign.keyPair.fromSeed(keyPair.secretKey)
}

export function identityPublicKeyToBase64(keyPair: IdentityKeyPair) {
  return bytesToBase64(keyPair.publicKey)
}

function pairingBundleSigningPayload(bundle: Pick<PairingPublicKeyBundle, 'public_key' | 'identity_public_key'>) {
  return encoder.encode(
    `falcondeck-pairing-bundle-v1\ndata_key_v1\ned25519_v1\n${bundle.public_key}\n${bundle.identity_public_key}`,
  )
}

function sessionBootstrapSigningPayload(material: SessionKeyMaterial) {
  return encoder.encode(
    `falcondeck-session-bootstrap-v1\ndata_key_v1\ned25519_v1\n${material.pairing_id}\n${material.session_id}\n${material.daemon_public_key}\n${material.daemon_identity_public_key}\n${material.client_public_key}\n${material.client_identity_public_key}\n${material.client_wrapped_data_key.wrapped_key}\n${material.daemon_wrapped_data_key?.wrapped_key ?? ''}`,
  )
}

export function buildPairingPublicKeyBundle(keyPair: BoxKeyPair): PairingPublicKeyBundle {
  const identityKeyPair = deriveIdentityKeyPair(keyPair)
  const bundle: PairingPublicKeyBundle = {
    encryption_variant: 'data_key_v1',
    identity_variant: 'ed25519_v1',
    public_key: publicKeyToBase64(keyPair),
    identity_public_key: identityPublicKeyToBase64(identityKeyPair),
    signature: '',
  }
  bundle.signature = bytesToBase64(
    nacl.sign.detached(pairingBundleSigningPayload(bundle), identityKeyPair.secretKey),
  )
  return bundle
}

export function verifyPairingPublicKeyBundle(bundle: PairingPublicKeyBundle) {
  if (
    bundle.encryption_variant !== 'data_key_v1' ||
    bundle.identity_variant !== 'ed25519_v1' ||
    !bundle.public_key ||
    !bundle.identity_public_key ||
    !bundle.signature
  ) {
    throw new Error('Pairing bundle signature is missing or invalid')
  }
  const publicKey = base64ToBytes(bundle.identity_public_key)
  const signature = base64ToBytes(bundle.signature)
  if (publicKey.length !== SIGNING_PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) {
    throw new Error('Pairing bundle signature is malformed')
  }
  if (!nacl.sign.detached.verify(pairingBundleSigningPayload(bundle), signature, publicKey)) {
    throw new Error('Pairing bundle signature verification failed')
  }
}

export function verifySessionKeyMaterial(
  material: SessionKeyMaterial,
  options?: {
    expectedSessionId?: string | null
    expectedPairingId?: string | null
    expectedDaemonPublicKey?: string | null
    expectedDaemonIdentityPublicKey?: string | null
    expectedClientPublicKey?: string | null
    expectedClientIdentityPublicKey?: string | null
  },
) {
  ensureVariant(material.encryption_variant)
  if (material.identity_variant !== 'ed25519_v1') {
    throw new Error(`Unsupported identity variant: ${material.identity_variant}`)
  }
  if (!material.signature) {
    throw new Error('Encrypted session bootstrap signature is missing')
  }
  if (options?.expectedSessionId && material.session_id !== options.expectedSessionId) {
    throw new Error('Encrypted session bootstrap has an unexpected session id')
  }
  if (options?.expectedPairingId && material.pairing_id !== options.expectedPairingId) {
    throw new Error('Encrypted session bootstrap has an unexpected pairing id')
  }
  if (options?.expectedDaemonPublicKey && material.daemon_public_key !== options.expectedDaemonPublicKey) {
    throw new Error('Encrypted session bootstrap has an unexpected daemon key')
  }
  if (
    options?.expectedDaemonIdentityPublicKey &&
    material.daemon_identity_public_key !== options.expectedDaemonIdentityPublicKey
  ) {
    throw new Error('Encrypted session bootstrap has an unexpected daemon identity key')
  }
  if (options?.expectedClientPublicKey && material.client_public_key !== options.expectedClientPublicKey) {
    throw new Error('Encrypted session bootstrap is not addressed to this client')
  }
  if (
    options?.expectedClientIdentityPublicKey &&
    material.client_identity_public_key !== options.expectedClientIdentityPublicKey
  ) {
    throw new Error('Encrypted session bootstrap is not addressed to this client identity')
  }
  const publicKey = base64ToBytes(material.daemon_identity_public_key)
  const signature = base64ToBytes(material.signature)
  if (publicKey.length !== SIGNING_PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) {
    throw new Error('Encrypted session bootstrap signature is malformed')
  }
  if (!nacl.sign.detached.verify(sessionBootstrapSigningPayload(material), signature, publicKey)) {
    throw new Error('Encrypted session bootstrap signature verification failed')
  }
}

export async function encryptJson(dataKey: Uint8Array, value: unknown): Promise<EncryptedEnvelope> {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new Error('Data key must be 32 bytes')
  }
  const nonce = randomBytes(AES_NONCE_BYTES)
  const plaintext = encoder.encode(JSON.stringify(value))
  const ciphertext = await encryptAesGcm(dataKey, nonce, plaintext)
  const bundle = concatBytes(new Uint8Array([CONTENT_VERSION]), nonce, ciphertext)
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
  const plaintext = await decryptAesGcm(dataKey, nonce, ciphertext)
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
  const localPublicKey = publicKeyToBase64(keyPair)
  const localIdentityPublicKey = identityPublicKeyToBase64(deriveIdentityKeyPair(keyPair))
  verifySessionKeyMaterial(material, {
    expectedClientPublicKey: localPublicKey,
    expectedClientIdentityPublicKey: localIdentityPublicKey,
  })
  const dataKey = unwrapDataKey(keyPair, material.client_wrapped_data_key)
  return { dataKey, material }
}
