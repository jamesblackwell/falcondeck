import '@/theme/unistyles'

import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Slot } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'

import { useRelayConnection } from '@/hooks/useRelayConnection'
import { clearMobileSessionCache, loadMobileSessionCache } from '@/storage/mobile-session-cache'
import { useRelayStore, useSessionStore } from '@/store'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false)
  useRelayConnection()

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
