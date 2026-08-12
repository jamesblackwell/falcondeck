import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { isTauriDesktop } from './api'

export type DesktopAttentionNotification = {
  title: string
  body: string
}

/**
 * Deliver an attention event through the native desktop notification center.
 *
 * The web Notification API is intentionally not used here: a packaged Tauri
 * app needs the native plugin so macOS registers FalconDeck as a notification
 * source and applies the app's bundle identity to delivered notifications.
 */
export async function sendDesktopAttentionNotification(
  notification: DesktopAttentionNotification,
): Promise<boolean> {
  if (!isTauriDesktop()) return false

  try {
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
