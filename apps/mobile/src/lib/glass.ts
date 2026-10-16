import type { ComponentType } from 'react'
import { useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform, type ViewProps } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * How the app paints its floating chrome on this device.
 *
 * - `liquid`: iOS 26 Liquid Glass through UIKit's own `UIGlassEffect`.
 * - `blur`: an older iOS with the system blur view; frosted, not refractive.
 * - `solid`: Android, Reduce Transparency, or a binary without either module.
 */
export type GlassMode = 'liquid' | 'blur' | 'solid'

export type NativeGlassViewProps = ViewProps & {
  glassEffectStyle?: 'regular' | 'clear' | 'none'
  tintColor?: string
  isInteractive?: boolean
  colorScheme?: 'auto' | 'light' | 'dark'
}

type GlassEffectModule = {
  GlassView: ComponentType<NativeGlassViewProps>
  GlassContainer: ComponentType<ViewProps & { spacing?: number }>
  isLiquidGlassAvailable: () => boolean
  isGlassEffectAPIAvailable?: () => boolean
}

// Both native modules ride along with expo-router, but a JS-only update can
// still land on a binary that predates one of them. Importing a missing view
// succeeds and then renders an "Unimplemented component" box, so ask the
// native registry first and fall back quietly.
function loadLiquidGlass(): GlassEffectModule | null {
  if (Platform.OS !== 'ios') return null
  try {
    if (requireOptionalNativeModule('ExpoGlassEffect') === null) return null
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const glass = require('expo-glass-effect') as GlassEffectModule
    if (!glass.isLiquidGlassAvailable()) return null
    // Some iOS 26 betas shipped the class without its initializer and crashed
    // on first use; the module reports that separately.
    if (glass.isGlassEffectAPIAvailable && !glass.isGlassEffectAPIAvailable()) return null
    return glass
  } catch {
    return null
  }
}

function loadBlurView(): ComponentType<Record<string, unknown>> | null {
  if (Platform.OS !== 'ios') return null
  try {
    if (requireOptionalNativeModule('ExpoBlurView') === null) return null
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('expo-blur').BlurView as ComponentType<Record<string, unknown>>) ?? null
  } catch {
    return null
  }
}

const liquidGlass = loadLiquidGlass()

/** UIKit's glass view, or null where Liquid Glass cannot render. */
export const NativeGlassView = liquidGlass?.GlassView ?? null
/** Lets adjacent glass shapes merge and morph, as UIKit's own bar items do. */
export const NativeGlassContainer = liquidGlass?.GlassContainer ?? null
/** The pre-iOS 26 system blur, or null where it is unavailable. */
export const NativeBlurView = loadBlurView()

const nativeMode: GlassMode = NativeGlassView ? 'liquid' : NativeBlurView ? 'blur' : 'solid'

// Reduce Transparency is one app-wide preference, so one subscription serves
// every surface instead of each glass control registering its own listener.
// It starts at module load, so the answer is usually in before first paint.
let reduceTransparency = false
const listeners = new Set<() => void>()

function publishReduceTransparency(value: boolean) {
  if (value === reduceTransparency) return
  reduceTransparency = value
  listeners.forEach((notify) => notify())
}

if (nativeMode !== 'solid') {
  try {
    AccessibilityInfo.addEventListener?.('reduceTransparencyChanged', publishReduceTransparency)
    void AccessibilityInfo.isReduceTransparencyEnabled?.()
      .then(publishReduceTransparency)
      .catch(() => {})
  } catch {
    // A missing accessibility bridge leaves the default: glass on.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getMode(): GlassMode {
  return reduceTransparency ? 'solid' : nativeMode
}

/** The chrome treatment for this device, following Reduce Transparency live. */
export function useGlassMode(): GlassMode {
  return useSyncExternalStore(subscribe, getMode, getMode)
}

/** The current mode outside React, for one-off decisions such as tint maths. */
export function currentGlassMode(): GlassMode {
  return getMode()
}
