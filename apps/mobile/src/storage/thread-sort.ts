import { isThreadSortMode, type ThreadSortMode } from '@falcondeck/client-core'

import { storage } from './mmkv'

const THREAD_SORT_STORAGE_KEY = 'falcondeck.mobile.thread-sort.v1'

/** Sidebar chat ordering is a per-device view preference, like desktop. */
export function readStoredThreadSort(): ThreadSortMode {
  try {
    const raw = storage.getString(THREAD_SORT_STORAGE_KEY)
    return isThreadSortMode(raw) ? raw : 'last_updated'
  } catch {
    return 'last_updated'
  }
}

export function writeStoredThreadSort(value: ThreadSortMode) {
  try {
    storage.set(THREAD_SORT_STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable; the in-memory value stays authoritative.
  }
}
