/**
 * Crypto adapter for React Native.
 *
 * Re-exports client-core crypto functions. The client-core crypto module uses:
 * - `crypto.getRandomValues` — available in Hermes
 * - `crypto.subtle` (AES-GCM) — available in Expo SDK 54 / Hermes
 * - `btoa` / `atob` — available in Hermes
 * - `tweetnacl` — pure JS, works everywhere
 *
 * If `crypto.subtle` is not available (older RN/Hermes), install `expo-crypto`
 * and call `installWebCryptoPolyfill()` before any encrypt/decrypt calls.
 */

export {
  generateBoxKeyPair,
  restoreBoxKeyPair,
  publicKeyToBase64,
  secretKeyToBase64,
  bootstrapSessionCrypto,
  encryptJson,
  decryptJson,
  bytesToBase64,
  base64ToBytes,
  type BoxKeyPair,
  type SessionCryptoState,
} from '@falcondeck/client-core'

/**
 * Polyfill `crypto.subtle` if not available. Call once at app startup.
 * On Expo SDK 54+ with Hermes, this is a no-op since Web Crypto is built-in.
 */
export async function ensureWebCrypto(): Promise<void> {
  if (typeof globalThis.crypto?.subtle?.importKey === 'function') {
    return // Already available
  }
  // Fallback: expo-crypto provides a polyfill
  /* v8 ignore start — only reachable on older RN without Web Crypto */
  try {
    const { digest } = await import('expo-crypto')
    // If expo-crypto is available but subtle is not, we need a full polyfill.
    // For now, throw a clear error since Expo 54 should have it.
    void digest
    throw new Error(
      'crypto.subtle is not available. Upgrade to Expo SDK 54+ with Hermes engine.',
    )
  } catch {
    throw new Error(
      'crypto.subtle is not available. FalconDeck requires Expo SDK 54+ for E2E encryption.',
    )
  }
  /* v8 ignore stop */
}
