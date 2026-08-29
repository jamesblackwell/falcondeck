import type {
  FalconDeckPreferences,
  ThinkingDisplay,
  ThreadSortMode,
  UpdatePreferencesPayload,
} from '@falcondeck/client-core'
import { isThreadSortMode, normalizePreferences } from '@falcondeck/client-core'

const ONBOARDING_STORAGE_KEY = 'falcondeck.desktop.onboarding.v1'
const THINKING_DISPLAY_STORAGE_KEY = 'falcondeck.desktop.thinking-display.v1'
const THREAD_SORT_STORAGE_KEY = 'falcondeck.desktop.thread-sort.v1'
const COLLAPSED_WORKSPACES_STORAGE_KEY =
  'falcondeck.desktop.collapsed-workspaces.v1'
const CHATS_COLLAPSED_STORAGE_KEY = 'falcondeck.desktop.chats-collapsed.v1'

const THINKING_DISPLAY_VALUES: ThinkingDisplay[] = [
  'auto',
  'preview',
  'always_expanded',
  'always_collapsed',
]

export type StoredOnboardingRecord = {
  completedAt: string
  skipped: boolean
  wizardVersion: number
}

export const CURRENT_ONBOARDING_WIZARD_VERSION = 1

/**
 * First-run onboarding is per-install UX: the completed flag lives in
 * device-local storage so resetting it never touches daemon state, and
 * remote-web clients pointed at an established daemon never see the wizard.
 * Returns null when onboarding has not been completed (the wizard should show).
 */
export function readStoredOnboarding(): StoredOnboardingRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredOnboardingRecord).completedAt !== 'string' ||
      typeof (parsed as StoredOnboardingRecord).skipped !== 'boolean' ||
      typeof (parsed as StoredOnboardingRecord).wizardVersion !== 'number'
    ) {
      return null
    }
    return parsed as StoredOnboardingRecord
  } catch {
    return null
  }
}

export function writeStoredOnboarding(record: StoredOnboardingRecord) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Storage can be unavailable; the in-session memory value stays
    // authoritative and the wizard simply re-runs next launch.
  }
}

/**
 * The Settings → General rerun control. Deletes only the onboarding flag;
 * projects, threads, keys, and daemon state all survive.
 */
export function clearStoredOnboarding() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

/**
 * The App-level gate for the first-run wizard. Eligibility is latched once per
 * launch (captured from storage at mount) so the Settings → General rerun
 * control takes effect on the next start, not mid-session: after the wizard
 * completes, `onboardingRecord` stays non-null for the rest of the session
 * even though storage was cleared. The wizard also only opens against a live
 * daemon connection, never a connecting spinner.
 */
export function shouldShowFirstRunOnboarding(options: {
  isTauri: boolean
  eligibleThisLaunch: boolean
  onboardingRecord: StoredOnboardingRecord | null
  connectionState: 'connecting' | 'ready' | 'error'
}): boolean {
  return (
    options.isTauri &&
    options.eligibleThisLaunch &&
    options.onboardingRecord === null &&
    options.connectionState === 'ready'
  )
}

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

/**
 * Which sidebar projects are folded away. Device-local like the sort mode: a
 * tidied sidebar is about this screen, not about the workspace itself.
 */
export function readStoredCollapsedWorkspaces(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

export function writeStoredCollapsedWorkspaces(value: readonly string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      COLLAPSED_WORKSPACES_STORAGE_KEY,
      JSON.stringify([...value]),
    )
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory value
    // stays authoritative for this session.
  }
}

/**
 * Whether the sidebar Chats list is folded away. Device-local like project
 * collapse: a tidied sidebar is about this screen, not the workspace.
 */
export function readStoredChatsCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(CHATS_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeStoredChatsCollapsed(value: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CHATS_COLLAPSED_STORAGE_KEY, String(value))
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
  const hasDaemonConversationFields = Object.values(rest).some(
    (value) => value !== undefined,
  )
  const daemonPayload: UpdatePreferencesPayload = { ...payload }
  if (hasDaemonConversationFields) daemonPayload.conversation = rest
  else delete daemonPayload.conversation
  const hasDaemonFields = Object.values(daemonPayload).some(
    (value) => value !== undefined,
  )
  return {
    daemonPayload: hasDaemonFields ? daemonPayload : null,
    thinkingDisplay,
  }
}
