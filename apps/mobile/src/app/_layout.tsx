import '@/theme/unistyles'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { InteractionManager } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useUnistyles } from 'react-native-unistyles'
import { Slot, useRouter } from 'expo-router'
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
  // Auth state is known once isReady flips; the offline cache hydrates a
  // beat later, after the first paint has landed (see the hydration effect).
  const [isHydrated, setIsHydrated] = useState(false)
  const sessionRestoredRef = useRef(false)
  const { rt } = useUnistyles()
  const router = useRouter()
  useRelayConnection()

  const openNotificationDestination = useCallback(() => {
    router.navigate('/(app)')
  }, [router])

  useEffect(() => {
    // Only after stores hydrate — a tap handled earlier would have its
    // workspace/thread selection clobbered by cache restoration. A tap that
    // lands during hydration is still delivered: it becomes the OS's last
    // notification response, which processInitialNotificationResponse below
    // picks up (deduped, so already-handled taps are not replayed).
    if (!isReady || !isHydrated) return
    const subscription = addNotificationResponseListener(openNotificationDestination)
    return () => {
      subscription?.remove()
    }
  }, [isReady, isHydrated, openNotificationDestination])

  useEffect(() => {
    // Only after stores hydrate — otherwise cache restoration would clobber
    // the workspace/thread selection made from the launching notification.
    if (!isReady || !isHydrated) return
    void processInitialNotificationResponse(openNotificationDestination)
  }, [isReady, isHydrated, openNotificationDestination])

  useEffect(() => {
    async function restore() {
      try {
        const restored = await useRelayStore.getState().restoreSession()
        sessionRestoredRef.current = restored
        if (!restored) {
          // Signed out: nothing cached to defer — clear synchronously so the
          // first painted frame already reflects a clean slate.
          useSessionStore.getState().reset()
          clearMobileSessionCache()
        }
        // Restored sessions do NOT block splash on hydrateCache: the offline
        // cache read+parse+normalize runs in the hydration effect below,
        // right after the first paint. Keeping restoreSession() (auth state)
        // blocking is what matters — splash still hides only once auth is
        // known and the tab tree can render something sensible.
      } finally {
        setIsReady(true)
        await SplashScreen.hideAsync()
      }
    }
    void restore()
  }, [])

  useEffect(() => {
    if (!isReady || isHydrated) return
    let cancelled = false

    // Ordering findings for deferring hydration past the first paint:
    // 1. No mounted UI requires hydrated data at mount. On a fresh install
    //    the store boots with `snapshot: null` until the daemon connects, so
    //    every screen already renders an empty/cold state; with the cache,
    //    screens briefly show those same empty states (~one interaction)
    //    before cached threads fill in.
    // 2. Notification taps MUST stay ordered AFTER hydrateCache:
    //    hydrateCache reconciles selection from the cache snapshot and would
    //    clobber a selection made by a launching notification — that is why
    //    the two effects above now gate on `isHydrated` as well as `isReady`.
    // 3. runAfterInteractions lets the initial navigation transition finish,
    //    so hydration cost lands between frames instead of stretching the
    //    splash. A requestAnimationFrame fallback covers environments without
    //    InteractionManager.
    function runHydration() {
      if (cancelled) return
      if (sessionRestoredRef.current) {
        const cachedSession = loadMobileSessionCache()
        if (cachedSession) {
          useSessionStore.getState().hydrateCache(cachedSession)
        }
      }
      setIsHydrated(true)
    }

    let cancelSchedule: () => void;
    if (typeof InteractionManager?.runAfterInteractions === 'function') {
      const handle = InteractionManager.runAfterInteractions(runHydration)
      cancelSchedule = () => handle.cancel()
    } else {
      const frame = requestAnimationFrame(runHydration)
      cancelSchedule = () => cancelAnimationFrame(frame)
    }

    return () => {
      cancelled = true
      cancelSchedule()
    }
  }, [isReady, isHydrated])

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
