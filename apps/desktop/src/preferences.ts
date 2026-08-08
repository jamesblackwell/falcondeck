import type {
  FalconDeckPreferences,
  ThinkingDisplay,
  ThreadSortMode,
  UpdatePreferencesPayload,
} from '@falcondeck/client-core'
import { isThreadSortMode, normalizePreferences } from '@falcondeck/client-core'

const THINKING_DISPLAY_STORAGE_KEY = 'falcondeck.desktop.thinking-display.v1'
const THREAD_SORT_STORAGE_KEY = 'falcondeck.desktop.thread-sort.v1'

const THINKING_DISPLAY_VALUES: ThinkingDisplay[] = [
  'auto',
  'preview',
  'always_expanded',
  'always_collapsed',
]

export function isThinkingDisplay(value: unknown): value is ThinkingDisplay {
  return THINKING_DISPLAY_VALUES.includes(value as ThinkingDisplay)
}

/**
 * The daemon's `falcondeck.json` has no `thinking_display` field yet, so it
 * would drop the value on the next snapshot. Until the daemon carries it, the
 * desktop keeps it device-local; the read/write pair is deliberately shaped
 * like the rest of the preference so swapping in the daemon round-trip later
 * touches only the two call sites in App.
 */
export function readStoredThinkingDisplay(): ThinkingDisplay {
  if (typeof window === 'undefined') return 'auto'
  try {
    const raw = window.localStorage.getItem(THINKING_DISPLAY_STORAGE_KEY)
    return isThinkingDisplay(raw) ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

export function writeStoredThinkingDisplay(value: ThinkingDisplay) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THINKING_DISPLAY_STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory value
    // stays authoritative for this session.
  }
}

/** Sidebar chat ordering is a per-device view preference, like zoom. */
export function readStoredThreadSort(): ThreadSortMode {
  if (typeof window === 'undefined') return 'last_updated'
  try {
    const raw = window.localStorage.getItem(THREAD_SORT_STORAGE_KEY)
    return isThreadSortMode(raw) ? raw : 'last_updated'
  } catch {
    return 'last_updated'
  }
}

export function writeStoredThreadSort(value: ThreadSortMode) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THREAD_SORT_STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory value
    // stays authoritative for this session.
  }
}

/** Overlays the device-local thinking preference onto the daemon's copy. */
export function preferencesWithThinkingDisplay(
  preferences: FalconDeckPreferences | null,
  thinkingDisplay: ThinkingDisplay,
): FalconDeckPreferences {
  const base = normalizePreferences(preferences)
  return {
    ...base,
    conversation: { ...base.conversation, thinking_display: thinkingDisplay },
  }
}

/**
 * Splits a preference update into the part the daemon owns and the part it does
 * not yet know about. Returns `null` for the daemon payload when the update was
 * purely device-local, so App can skip a no-op round trip.
 */
export function splitPreferencesUpdate(payload: UpdatePreferencesPayload): {
  daemonPayload: UpdatePreferencesPayload | null
  thinkingDisplay: ThinkingDisplay | null
} {
  const conversation = payload.conversation
  if (!conversation || !isThinkingDisplay(conversation.thinking_display)) {
    return { daemonPayload: payload, thinkingDisplay: null }
  }

  const { thinking_display: thinkingDisplay, ...rest } = conversation
  const hasDaemonFields = Object.values(rest).some((value) => value !== undefined)
  return {
    daemonPayload: hasDaemonFields ? { ...payload, conversation: rest } : null,
    thinkingDisplay,
  }
}
