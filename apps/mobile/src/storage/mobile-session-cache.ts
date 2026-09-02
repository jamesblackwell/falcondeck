import {
  MOBILE_SESSION_CACHE_VERSION,
  type MobileSessionCache,
} from '@falcondeck/client-core'

import { getJson, removeKey, setJson } from './mmkv'
import {
  decryptSessionValue,
  encryptSessionValue,
  setSessionStorageEncryptionKey,
} from './session-encrypted-storage'

const MOBILE_SESSION_CACHE_KEY = 'mobile.session-cache'
export function setMobileSessionCacheKey(dataKey: Uint8Array | null): void {
  setSessionStorageEncryptionKey(dataKey)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidMobileSessionCache(value: unknown): value is MobileSessionCache {
  if (!isRecord(value) || value.version !== MOBILE_SESSION_CACHE_VERSION) return false
  if (!isRecord(value.snapshot)) return false
  if (
    !Array.isArray(value.snapshot.workspaces) ||
    !Array.isArray(value.snapshot.threads) ||
    !Array.isArray(value.snapshot.interactive_requests)
  ) return false
  if (
    value.selectedWorkspaceId !== null &&
    typeof value.selectedWorkspaceId !== 'string'
  ) return false
  if (
    value.selectedThreadId !== null &&
    typeof value.selectedThreadId !== 'string'
  ) return false
  if (
    !Array.isArray(value.recentThreadIds) ||
    !value.recentThreadIds.every((threadId) => typeof threadId === 'string')
  ) return false
  if (!isRecord(value.threadHistories)) return false
  return Object.values(value.threadHistories).every(
    (history) => isRecord(history) && Array.isArray(history.items),
  )
}

export function loadMobileSessionCache(): MobileSessionCache | null {
  const envelope = getJson<unknown>(MOBILE_SESSION_CACHE_KEY)
  if (!envelope) return null
  const cached = decryptSessionValue(envelope)
  if (!cached) {
    // Includes migration from the historical plaintext shape: never hydrate
    // sensitive data that was not authenticated for the restored session.
    removeKey(MOBILE_SESSION_CACHE_KEY)
    return null
  }
  if (!isValidMobileSessionCache(cached)) {
    removeKey(MOBILE_SESSION_CACHE_KEY)
    return null
  }
  return cached
}

export function persistMobileSessionCache(cache: MobileSessionCache | null): void {
  if (!cache) {
    removeKey(MOBILE_SESSION_CACHE_KEY)
    return
  }
  const normalized = {
    ...cache,
    version: MOBILE_SESSION_CACHE_VERSION,
  } satisfies MobileSessionCache
  const encrypted = encryptSessionValue(normalized)
  if (encrypted) setJson(MOBILE_SESSION_CACHE_KEY, encrypted)
}

export function clearMobileSessionCache(): void {
  removeKey(MOBILE_SESSION_CACHE_KEY)
}
