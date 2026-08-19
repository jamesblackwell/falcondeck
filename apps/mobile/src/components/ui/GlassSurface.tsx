import type { ComponentType, ReactNode } from 'react'
import { requireOptionalNativeModule } from 'expo-modules-core'
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

// expo-blur is a native module, and a JS-only OTA update can land on a binary
// that predates it. Importing it there still succeeds — the failure only shows
// up at render, as an "Unimplemented component" box — so ask the native
// registry whether the view actually exists before using it.
let NativeBlurView: ComponentType<Record<string, unknown>> | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const installed = requireOptionalNativeModule('ExpoBlurView') !== null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  NativeBlurView = installed ? (require('expo-blur').BlurView ?? null) : null
} catch {
  NativeBlurView = null
}

/** Blur only reads as glass on iOS; elsewhere the tint alone stands in. */
export const canBlur = Platform.OS === 'ios' && NativeBlurView !== null

/** Fill for a control sitting on glass: tints the panel rather than hiding it. */
export function glassFill(isDark: boolean) {
  return isDark ? 'rgba(255, 255, 255, 0.09)' : 'rgba(9, 9, 11, 0.05)'
}

/** Selected-state fill: reads as raised against a plain {@link glassFill}. */
export function glassFillStrong(isDark: boolean) {
  return isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(9, 9, 11, 0.12)'
}

/** Hairline that gives a glass-on-glass control its edge. */
export function glassEdge(isDark: boolean) {
  return isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(9, 9, 11, 0.07)'
}

interface GlassSurfaceProps {
  children: ReactNode
  /** Corner radius; pair with the caller's own layout style. */
  radius: number
  /** iOS blur strength. Chrome that must stay legible wants 40-70. */
  intensity?: number
  style?: StyleProp<ViewStyle>
  /** Layout for the clipped content layer — padding, gap, and the like. */
  contentStyle?: StyleProp<ViewStyle>
  /** Drops the specular top edge for small controls where it reads as a seam. */
  highlight?: boolean
}

/**
 * A frosted panel: system blur, a translucent palette tint so the app's colour
 * theme still shows through, a hairline rim, and a specular top edge. The
 * clipping layer is separate from the shadow layer because a view cannot both
 * clip its children and cast a shadow.
 */
export function GlassSurface({
  children,
  radius,
  intensity = 60,
  style,
  contentStyle,
  highlight = true,
}: GlassSurfaceProps) {
  const { theme } = useUnistyles()

  return (
    <View style={[styles.shadow, { borderRadius: radius }, style]}>
      <View style={[styles.clip, { borderRadius: radius }, contentStyle]}>
        {canBlur && NativeBlurView ? (
          <NativeBlurView
            intensity={intensity}
            tint={theme.isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={[styles.fill, canBlur ? styles.fillBlurred : null]} />
        <View style={[styles.rim, { borderRadius: radius }]} pointerEvents="none" />
        {highlight ? <View style={styles.highlight} pointerEvents="none" /> : null}
        {children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  shadow: {
    borderCurve: 'continuous',
    ...theme.shadow.md,
    // The panel is translucent, so a heavy drop shadow shows straight through
    // it; keep the ambient lift subtle.
    shadowOpacity: theme.isDark ? 0.35 : 0.12,
  },
  clip: {
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface[2],
  },
  fillBlurred: {
    // Over a live blur the tint only needs to colour it toward the palette.
    opacity: theme.isDark ? 0.5 : 0.4,
  },
  rim: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(9, 9, 11, 0.1)',
    borderCurve: 'continuous',
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: '12%',
    right: '12%',
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.9)',
  },
}))
