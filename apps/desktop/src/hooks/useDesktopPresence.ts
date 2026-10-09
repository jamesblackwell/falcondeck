import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { isTauriDesktop } from '../api'

const AWAY_AFTER_MS = 120_000
const PRESENCE_POLL_MS = 15_000

type ActivityClient = {
  setClientActivity(active: boolean): Promise<void>
}

/** Window focus controls what is seen; desktop presence controls phone pushes. */
export function useDesktopPresence(api: ActivityClient | null) {
  const [windowFocused, setWindowFocused] = useState(
    () => document.visibilityState !== 'hidden' && document.hasFocus(),
  )
  // Wait for the native probe before marking an unattended window's task read.
  const [desktopPresent, setDesktopPresent] = useState(() => !isTauriDesktop())

  useEffect(() => {
    let disposed = false
    let focusRevision = 0
    let nativeUnlisten: (() => void) | undefined
    let lastInteractionAt = document.hasFocus() ? Date.now() : -Infinity
    let probing = false

    const publishPresence = async () => {
      if (probing || disposed) return
      probing = true
      try {
        const nativePresence = isTauriDesktop()
          ? await invoke<boolean | null>('desktop_user_present').catch(() => null)
          : null
        if (disposed) return
        const present = nativePresence ?? (Date.now() - lastInteractionAt < AWAY_AFTER_MS)
        setDesktopPresent(present)
        // The Mac daemon queries hardware idle time itself, even if this
        // webview is hidden or suspended. Other platforms use a short lease.
        if (nativePresence === null) {
          void api?.setClientActivity(present).catch(() => {})
        }
      } finally {
        probing = false
      }
    }

    const updateFocus = (focused: boolean) => {
      focusRevision += 1
      setWindowFocused(focused)
      if (focused) lastInteractionAt = Date.now()
      void publishPresence()
    }
    const handleFocus = () => updateFocus(document.visibilityState !== 'hidden')
    const handleBlur = () => updateFocus(false)
    const handleVisibility = () => updateFocus(
      document.visibilityState !== 'hidden' && document.hasFocus(),
    )
    const handleInput = () => {
      lastInteractionAt = Date.now()
      setDesktopPresent(true)
    }

    void publishPresence()
    const heartbeat = window.setInterval(() => void publishPresence(), PRESENCE_POLL_MS)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
      window.addEventListener(event, handleInput, { passive: true })
    }

    if (isTauriDesktop()) {
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        if (disposed) return
        const currentWindow = getCurrentWindow()
        const revision = focusRevision
        void currentWindow.isFocused().then((focused) => {
          if (!disposed && focusRevision === revision) setWindowFocused(focused)
        }).catch(() => {})
        const unlisten = await currentWindow.onFocusChanged(({ payload }) => {
          if (!disposed) updateFocus(payload)
        })
        if (disposed) unlisten()
        else nativeUnlisten = unlisten
      }).catch(() => {})
    }

    return () => {
      disposed = true
      nativeUnlisten?.()
      window.clearInterval(heartbeat)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
      for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
        window.removeEventListener(event, handleInput)
      }
      void api?.setClientActivity(false).catch(() => {})
    }
  }, [api])

  return { windowFocused, desktopPresent }
}
