import '@/theme/unistyles'

import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
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
  useRelayConnection()

  useEffect(() => {
    const subscription = addNotificationResponseListener()
    return () => {
      subscription?.remove()
    }
  }, [])

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
        <StatusBar style="light" />
        <Slot />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
