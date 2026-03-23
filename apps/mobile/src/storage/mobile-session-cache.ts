import {
  MOBILE_SESSION_CACHE_VERSION,
  type MobileSessionCache,
} from '@falcondeck/client-core'

import { getJson, removeKey, setJson } from './mmkv'

const MOBILE_SESSION_CACHE_KEY = 'mobile.session-cache'

export function loadMobileSessionCache(): MobileSessionCache | null {
  const cached = getJson<MobileSessionCache>(MOBILE_SESSION_CACHE_KEY)
  if (!cached) return null
  if (cached.version !== MOBILE_SESSION_CACHE_VERSION) {
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

  setJson(MOBILE_SESSION_CACHE_KEY, {
    ...cache,
    version: MOBILE_SESSION_CACHE_VERSION,
  } satisfies MobileSessionCache)
}

export function clearMobileSessionCache(): void {
  removeKey(MOBILE_SESSION_CACHE_KEY)
}
