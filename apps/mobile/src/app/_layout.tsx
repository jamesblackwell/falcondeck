import '@/theme/unistyles'

import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Slot } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'

import { useRelayStore } from '@/store'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    async function restore() {
      try {
        const restored = await useRelayStore.getState().restoreSession()
        if (!restored) {
          // No saved session — will show pairing screen
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
