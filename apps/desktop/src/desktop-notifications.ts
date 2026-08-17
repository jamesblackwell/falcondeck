import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { invoke } from '@tauri-apps/api/core'

import { isTauriDesktop } from './api'

export type DesktopAttentionNotification = {
  title: string
  body: string
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
