import { storage } from './mmkv'

const CHATS_COLLAPSED_STORAGE_KEY = 'falcondeck.mobile.chats-collapsed.v1'

/** Whether the sidebar Chats list is folded away. Device-local like sort. */
export function readStoredChatsCollapsed(): boolean {
  try {
    return storage.getBoolean(CHATS_COLLAPSED_STORAGE_KEY) ?? false
  } catch {
    return false
  }
}

export function writeStoredChatsCollapsed(value: boolean) {
  try {
    storage.set(CHATS_COLLAPSED_STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable; the in-memory value stays authoritative.
  }
}
