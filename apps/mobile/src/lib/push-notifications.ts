/**
 * Push notification support for agent-attention alerts.
 *
 * The relay sends an Expo push (generic content, no conversation data) when an
 * agent needs attention and this device is not connected. This module:
 *  - requests permission and fetches the Expo push token (skipping gracefully
 *    on simulators/Expo Go or when permission is denied),
 *  - registers the token with the relay, deduped so we only re-POST when the
 *    token, session, or device changes,
 *  - suppresses foreground alerts (the user is already looking at live state),
 *  - routes notification taps to the right workspace/thread.
 *
 * Every entry point is defensive: push failures must never break startup,
 * pairing, or the relay connection. Failures degrade to a console.warn.
 */
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'

import { getJson, setJson, removeKey } from '@/storage/mmkv'
import { useSessionStore } from '@/store/session-store'

const PUSH_REGISTRATION_KEY = 'push.lastRegistration'
const PUSH_ENABLED_KEY = 'push.enabled'
const PUSH_LAST_HANDLED_RESPONSE_KEY = 'push.lastHandledNotificationResponse'

interface PersistedPushRegistration {
  sessionId: string
  deviceId: string
  token: string
}

/** Payload the relay attaches to agent-attention pushes. */
export interface PushNotificationData {
  sessionId?: string
  workspaceId?: string | null
  threadId?: string | null
  kind?: string
}

export type NotificationDestinationHandler = () => void

/**
 * User preference for agent-attention pushes. Defaults to enabled so paired
 * devices get alerts without any setup.
 */
export function isPushEnabled(): boolean {
  const stored = getJson<unknown>(PUSH_ENABLED_KEY)
  return typeof stored === 'boolean' ? stored : true
}

/** Persist the push-notification preference. */
export function setPushEnabled(enabled: boolean): void {
  setJson(PUSH_ENABLED_KEY, enabled)
}

function pushTokenUrl(relayUrl: string, sessionId: string, deviceId: string) {
  const base = relayUrl.trim().replace(/\/$/, '')
  return `${base}/v1/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}/push-token`
}

async function postPushToken(
  relayUrl: string,
  sessionId: string,
  deviceId: string,
  clientToken: string,
  pushToken: string | null,
): Promise<boolean> {
  const response = await fetch(pushTokenUrl(relayUrl, sessionId, deviceId), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ push_token: pushToken }),
  })
  if (!response.ok) {
    throw new Error(`Push token registration failed with status ${response.status}`)
  }
  return true
}

/**
 * Suppress alert banners/sounds while the app is foregrounded — the user is
 * already looking at live state. The handler only runs for notifications that
 * arrive while the app is active, so returning "silent" here is exactly the
 * foreground-suppression behavior we want.
 */
export function configureForegroundNotificationHandler(): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    })
  } catch (error) {
    console.warn('Failed to configure notification handler', error)
  }
}

/** Android 8+ requires an explicit channel before any notification can show. */
export async function ensureAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Agent attention',
      importance: Notifications.AndroidImportance.HIGH,
    })
  } catch (error) {
    console.warn('Failed to create Android notification channel', error)
  }
}

/**
 * Fetch the Expo push token, or null when unavailable (permission denied,
 * simulator, Expo Go, or any native failure). Never throws.
 */
export async function getPushTokenSafely(): Promise<string | null> {
  try {
    // Push tokens are unavailable on simulators/emulators.
    if (!Device.isDevice) return null

    const current = await Notifications.getPermissionsAsync()
    let granted = current.granted
    if (!granted && current.canAskAgain !== false) {
      const requested = await Notifications.requestPermissionsAsync()
      granted = requested.granted
    }
    if (!granted) return null

    const projectId: string | undefined =
      Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    )
    return token.data ?? null
  } catch (error) {
    // Expo Go / missing native module / permission edge cases all land here.
    console.warn('Push token unavailable', error)
    return null
  }
}

// registerPushToken and clearPushToken can race — the settings toggle, the
// connection effect, and disconnect all fire them independently. Serialize
// them through a single promise chain so a stale registration can never land
// after a clear. Operations swallow their own errors, so the chain never
// rejects.
let pushTokenOperations: Promise<void> = Promise.resolve()

function enqueuePushTokenOperation(operation: () => Promise<void>): Promise<void> {
  const next = pushTokenOperations.then(operation)
  pushTokenOperations = next
  return next
}

/**
 * Register this device's Expo push token with the relay. Fire-and-forget safe:
 * never throws, no-ops while the user has push notifications disabled, and
 * re-POSTs only when the token, session, or device changed since the last
 * successful registration.
 */
export async function registerPushToken(
  relayUrl: string,
  sessionId: string,
  deviceId: string,
  clientToken: string,
): Promise<void> {
  return enqueuePushTokenOperation(async () => {
    try {
      if (!isPushEnabled()) return

      const token = await getPushTokenSafely()
      if (!token) return

      // The permission prompt can stay open long enough for the user to flip
      // the push toggle off; re-check before POSTing so a freshly disabled
      // device does not (re)register.
      if (!isPushEnabled()) return

      const last = getJson<PersistedPushRegistration>(PUSH_REGISTRATION_KEY)
      if (last && last.token === token && last.sessionId === sessionId && last.deviceId === deviceId) {
        return
      }

      await postPushToken(relayUrl, sessionId, deviceId, clientToken, token)
      setJson(PUSH_REGISTRATION_KEY, {
        sessionId,
        deviceId,
        token,
      } satisfies PersistedPushRegistration)
    } catch (error) {
      console.warn('Failed to register push token with relay', error)
    }
  })
}

/**
 * Clear the push token on the relay (sends `push_token: null`) and forget the
 * local dedupe record so a later registration re-POSTs. Never throws.
 */
export async function clearPushToken(
  relayUrl: string,
  sessionId: string,
  deviceId: string,
  clientToken: string,
): Promise<void> {
  return enqueuePushTokenOperation(async () => {
    try {
      removeKey(PUSH_REGISTRATION_KEY)
      await postPushToken(relayUrl, sessionId, deviceId, clientToken, null)
    } catch (error) {
      console.warn('Failed to clear push token on relay', error)
    }
  })
}

/**
 * Route a notification tap to the referenced workspace/thread using the same
 * selection actions the sidebar uses. Returns true when a selection was made.
 */
export function handleNotificationTapData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const { sessionId, workspaceId, threadId } = data as PushNotificationData
  if (typeof sessionId === 'string') {
    const activeSessionId = getJson<{ sessionId?: unknown }>('relay.session')?.sessionId
    if (activeSessionId !== sessionId) return false
  }
  const session = useSessionStore.getState()

  if (typeof workspaceId === 'string' && typeof threadId === 'string') {
    const owner = session.snapshot?.threads.find((thread) => thread.id === threadId)
    if (session.snapshot && owner?.workspace_id !== workspaceId) return false
    session.selectThread(workspaceId, threadId)
    return true
  }
  if (typeof threadId === 'string') {
    // No workspace in the payload — resolve it from the snapshot if we can.
    const owner = session.snapshot?.threads.find((thread) => thread.id === threadId)
    if (owner) {
      session.selectThread(owner.workspace_id, threadId)
      return true
    }
    return false
  }
  if (typeof workspaceId === 'string') {
    if (
      session.snapshot &&
      !session.snapshot.workspaces.some((workspace) => workspace.id === workspaceId)
    ) {
      return false
    }
    session.selectWorkspace(workspaceId)
    return true
  }
  return false
}

function dataFromResponse(response: Notifications.NotificationResponse | null): unknown {
  return response?.notification?.request?.content?.data ?? null
}

function responseIdentifier(response: Notifications.NotificationResponse): string | null {
  const identifier = response?.notification?.request?.identifier
  return typeof identifier === 'string' && identifier.length > 0 ? identifier : null
}

/**
 * Remember which tap response was last handled so a cold start cannot replay
 * it: getLastNotificationResponseAsync returns the last response EVER, not
 * just the one that launched the current process.
 */
function rememberHandledResponse(response: Notifications.NotificationResponse): void {
  const identifier = responseIdentifier(response)
  if (identifier) {
    setJson(PUSH_LAST_HANDLED_RESPONSE_KEY, identifier)
  }
}

function wasResponseAlreadyHandled(response: Notifications.NotificationResponse): boolean {
  const identifier = responseIdentifier(response)
  return !!identifier && getJson<string>(PUSH_LAST_HANDLED_RESPONSE_KEY) === identifier
}

/**
 * Subscribe to notification taps. Returns the subscription (or null when the
 * native module is unavailable) — callers must remove it on cleanup.
 */
export function addNotificationResponseListener(
  openDestination?: NotificationDestinationHandler,
): { remove: () => void } | null {
  try {
    return Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        rememberHandledResponse(response)
        if (handleNotificationTapData(dataFromResponse(response))) {
          openDestination?.()
        }
      } catch (error) {
        console.warn('Failed to handle notification tap', error)
      }
    })
  } catch (error) {
    console.warn('Failed to subscribe to notification taps', error)
    return null
  }
}

let initialResponseProcessed = false

/** Test-only: allow re-running the cold-start tap handling. */
export function __resetInitialNotificationResponseForTests(): void {
  initialResponseProcessed = false
}

/**
 * Handle the tap that cold-started the app (the response listener can miss
 * it). Call once the stores have hydrated so the selection is not clobbered.
 * Skips responses already handled in this or an earlier app run.
 */
export async function processInitialNotificationResponse(
  openDestination?: NotificationDestinationHandler,
): Promise<void> {
  if (initialResponseProcessed) return
  initialResponseProcessed = true
  try {
    const response = await Notifications.getLastNotificationResponseAsync()
    if (!response || wasResponseAlreadyHandled(response)) return
    rememberHandledResponse(response)
    if (handleNotificationTapData(dataFromResponse(response))) {
      openDestination?.()
    }
    // Where the installed SDK supports it, also clear the stored response so
    // even an identifier-less response cannot replay on the next cold start.
    const clearLastResponse = (
      Notifications as { clearLastNotificationResponseAsync?: () => Promise<void> }
    ).clearLastNotificationResponseAsync
    if (typeof clearLastResponse === 'function') {
      await clearLastResponse()
    }
  } catch (error) {
    // The native lookup did not establish whether a launch response exists;
    // allow a later startup pass to retry instead of latching the failure.
    initialResponseProcessed = false
    console.warn('Failed to process launch notification', error)
  }
}
