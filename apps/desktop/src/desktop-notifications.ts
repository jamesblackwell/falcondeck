import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { invoke } from '@tauri-apps/api/core'
import {
  deriveThreadAttentionPresentation,
  type InteractiveRequest,
  type NotificationPreferences,
  type ThreadSummary,
} from '@falcondeck/client-core'

import { isTauriDesktop } from './api'

export type DesktopAttentionNotification = {
  title: string
  body: string
}

/** Deduplicate the particular turn or request, rather than its attention level. */
export function desktopAttentionNotification(
  thread: ThreadSummary,
  requests: InteractiveRequest[],
  preferences: NotificationPreferences,
): (DesktopAttentionNotification & { key: string }) | null {
  if (!preferences.enabled || thread.is_archived) return null
  const attention = deriveThreadAttentionPresentation(thread, requests)
  const title = thread.title || 'FalconDeck task'
  if (attention.level === 'awaiting_response' && preferences.notify_on_input_required) {
    const requestIds = requests
      .filter((request) => request.workspace_id === thread.workspace_id && request.thread_id === thread.id)
      .map((request) => request.request_id)
      .sort()
    return {
      title,
      body: 'The agent needs a response in this task.',
      key: `input:${requestIds.length ? requestIds.join(',') : thread.attention.last_agent_activity_seq}`,
    }
  }
  // Reading an old failure should not make its permanent error status alert again.
  if (!attention.unread) return null
  const turnKey = thread.latest_turn_id ?? thread.attention.last_agent_activity_seq
  if (attention.level === 'error' && preferences.notify_on_error) {
    return { title, body: 'The latest run ended with an error.', key: `error:${turnKey}` }
  }
  if (attention.level === 'unread' && preferences.notify_on_turn_complete) {
    return { title, body: 'The latest turn finished.', key: `complete:${turnKey}` }
  }
  return null
}

type NativeMacOSPermissionState = 'default' | 'denied' | 'granted' | 'unsupported'

async function sendNativeMacOSNotification(
  notification: DesktopAttentionNotification,
): Promise<boolean | null> {
  let permission = await invoke<NativeMacOSPermissionState>(
    'macos_notification_permission_state',
  )
  if (permission === 'unsupported') return null

  if (permission === 'default') {
    permission = await invoke<NativeMacOSPermissionState>(
      'request_macos_notification_permission',
    )
  }
  if (permission !== 'granted') return false

  await invoke('send_macos_notification', notification)
  return true
}

/**
 * Deliver an attention event through the native desktop notification center.
 *
 * The web Notification API is intentionally not used here. Packaged macOS
 * builds use UNUserNotificationCenter under FalconDeck's bundle identity;
 * other desktop platforms keep the Tauri plugin fallback.
 */
export async function sendDesktopAttentionNotification(
  notification: DesktopAttentionNotification,
): Promise<boolean> {
  if (!isTauriDesktop()) return false

  try {
    const nativeResult = await sendNativeMacOSNotification(notification)
    if (nativeResult !== null) return nativeResult

    let granted = await isPermissionGranted()
    if (!granted) {
      granted = (await requestPermission()) === 'granted'
    }
    if (!granted) return false

    await sendNotification({
      title: notification.title,
      body: notification.body,
      sound: 'Ping',
    })
    return true
  } catch (error) {
    console.warn('FalconDeck could not deliver a desktop notification', error)
    return false
  }
}
