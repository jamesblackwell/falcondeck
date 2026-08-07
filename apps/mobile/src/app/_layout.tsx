import '@/theme/unistyles'

import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useUnistyles } from 'react-native-unistyles'
import { Slot } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'

import { useRelayConnection } from '@/hooks/useRelayConnection'
import {
  addNotificationResponseListener,
  configureForegroundNotificationHandler,
  ensureAndroidNotificationChannel,
  processInitialNotificationResponse,
} from '@/lib/push-notifications'
import { clearMobileSessionCache, loadMobileSessionCache } from '@/storage/mobile-session-cache'
import { useRelayStore, useSessionStore } from '@/store'

SplashScreen.preventAutoHideAsync()

// Configure before any notification can arrive: suppress alerts while the app
// is foregrounded, and make sure Android 8+ has a channel to post to. Both are
// no-throw and degrade silently where notifications are unavailable.
configureForegroundNotificationHandler()
void ensureAndroidNotificationChannel()

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false)
  const { rt } = useUnistyles()
  useRelayConnection()

  useEffect(() => {
    // Only after stores hydrate — a tap handled earlier would have its
    // workspace/thread selection clobbered by cache restoration. A tap that
    // lands during hydration is still delivered: it becomes the OS's last
    // notification response, which processInitialNotificationResponse below
    // picks up (deduped, so already-handled taps are not replayed).
    if (!isReady) return
    const subscription = addNotificationResponseListener()
    return () => {
      subscription?.remove()
    }
  }, [isReady])

  useEffect(() => {
    // Only after stores hydrate — otherwise cache restoration would clobber
    // the workspace/thread selection made from the launching notification.
    if (!isReady) return
    void processInitialNotificationResponse()
  }, [isReady])

  useEffect(() => {
    async function restore() {
      try {
        const restored = await useRelayStore.getState().restoreSession()
        if (restored) {
          const cachedSession = loadMobileSessionCache()
          if (cachedSession) {
            useSessionStore.getState().hydrateCache(cachedSession)
          }
        } else {
          useSessionStore.getState().reset()
          clearMobileSessionCache()
        }
      } finally {
        setIsReady(true)
        await SplashScreen.hideAsync()
      }
    }
    void restore()
  }, [])

  if (!isReady) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={rt.themeName === 'light' ? 'dark' : 'light'} />
        <Slot />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
