import { useSyncExternalStore } from 'react'
import { StyleSheet } from 'react-native-unistyles'

// Mirrors Unistyles' UnistyleDependency values; the enum is not exported.
const THEME = 0
const THEME_NAME = 1

let version = 0
const listeners = new Set<() => void>()
let unsubscribeNative: (() => void) | null = null

type ChangeListenerHost = {
  addChangeListener?: (onChanged: (dependencies: number[]) => void) => () => void
}

function ensureNativeSubscription() {
  if (unsubscribeNative) return
  // Private on the type but public at runtime: the same hook Unistyles' own
  // `useUnistyles` listens on. One listener serves the whole app.
  const host = StyleSheet as unknown as ChangeListenerHost
  unsubscribeNative =
    host.addChangeListener?.((dependencies) => {
      if (!dependencies.includes(THEME) && !dependencies.includes(THEME_NAME)) return
      version += 1
      listeners.forEach((notify) => notify())
    }) ?? (() => {})
}

function subscribe(listener: () => void) {
  ensureNativeSubscription()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getVersion = () => version

/**
 * Re-renders the caller whenever the active theme changes — light/dark,
 * palette, or text size.
 *
 * Unistyles repaints React Native's own views natively, but it cannot reach
 * into third-party host components. Text renders through UITextView on iOS,
 * so without this a memoised label kept the previous theme's colours until
 * something else happened to re-render it: switching the phone to light mode
 * left near-white text on a white sidebar.
 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}
