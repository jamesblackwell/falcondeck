import type { ReactNode } from 'react'
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { NativeBlurView, NativeGlassView, useGlassMode, type GlassMode } from '@/lib/glass'
import { withAlpha } from '@/theme/color'

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

export interface GlassSurfaceProps {
  children?: ReactNode
  /** Corner radius; pair with the caller's own layout style. */
  radius: number
  /**
   * `regular` is the default material for bars and controls. `clear` is
   * Apple's more transparent variant, for chrome over rich media only.
   */
  variant?: 'regular' | 'clear'
  /**
   * Colours the glass itself, as UIKit's prominent glass does with the
   * accent. A palette surface at partial opacity calms busy content behind a
   * reading surface such as a sheet.
   */
  tint?: string
  /** Lets Liquid Glass answer touches with its own press response. */
  interactive?: boolean
  /** Fallback blur strength before iOS 26. Chrome that must stay legible wants 40-70. */
  intensity?: number
  /** Drops the specular top edge of the fallback blur where it reads as a seam. */
  highlight?: boolean
  /** Casts the soft ambient shadow the fallbacks need to lift off the page. */
  elevated?: boolean
  /**
   * The glass fills a box whose size the caller fixes (a button, a bar). Off
   * by default: in a content-sized stack, a growing glass layer would claim
   * the free space and shove its neighbours away.
   */
  fill?: boolean
  style?: StyleProp<ViewStyle>
  /** Layout for the content layer — padding, gap, and the like. */
  contentStyle?: StyleProp<ViewStyle>
  pointerEvents?: ViewProps['pointerEvents']
  testID?: string
  onLayout?: ViewProps['onLayout']
}

/**
 * The app's floating-chrome material.
 *
 * On iOS 26 this is UIKit's own Liquid Glass (`UIGlassEffect`), so lensing,
 * edge highlights, light/dark adaptation and the press response all come
 * from the system. Older iOS gets a frosted system blur tinted toward the
 * palette; Android and Reduce Transparency get an opaque surface with a
 * hairline, which is what Apple prescribes for the same setting.
 *
 * Glass is for navigation and controls that float over content. Content
 * itself — messages, cards, lists — stays opaque for reading contrast.
 */
export function GlassSurface({
  children,
  radius,
  variant = 'regular',
  tint,
  interactive = false,
  intensity = 60,
  highlight = true,
  elevated = true,
  fill = false,
  style,
  contentStyle,
  pointerEvents,
  testID,
  onLayout,
}: GlassSurfaceProps) {
  const { theme } = useUnistyles()
  const mode: GlassMode = useGlassMode()
  const shape = { borderRadius: radius }

  if (mode === 'liquid' && NativeGlassView) {
    const glass = (
      <NativeGlassView
        testID={elevated ? undefined : testID}
        onLayout={elevated ? undefined : onLayout}
        pointerEvents={pointerEvents}
        glassEffectStyle={variant}
        tintColor={tint}
        isInteractive={interactive}
        // The app owns its light/dark choice (and its palettes), which can
        // differ from the system appearance, so the glass follows the app.
        colorScheme={theme.isDark ? 'dark' : 'light'}
        style={[
          styles.liquid,
          shape,
          elevated ? (fill ? styles.liquidFill : null) : style,
          contentStyle,
        ]}
      >
        {children}
      </NativeGlassView>
    )
    if (!elevated) return glass
    // Over a flat page there is nothing behind the glass to refract, so on
    // its own it all but disappears in light themes. A soft drop shadow and a
    // hairline ring — drawn by a wrapper, outside the clipped glass — give it
    // the lift and edge UIKit's own floating glass has.
    return (
      <View
        testID={testID}
        onLayout={onLayout}
        pointerEvents={pointerEvents === 'none' ? 'none' : 'box-none'}
        style={[styles.liquidShadow, shape, style]}
      >
        {glass}
      </View>
    )
  }

  if (mode === 'blur' && NativeBlurView) {
    return (
      <View
        testID={testID}
        onLayout={onLayout}
        pointerEvents={pointerEvents}
        style={[styles.shadow, elevated ? styles.elevated : null, shape, style]}
      >
        <View style={[styles.clip, shape, contentStyle]}>
          <NativeBlurView
            intensity={intensity}
            tint={theme.isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              styles.fill,
              styles.fillBlurred,
              tint ? { backgroundColor: tint, opacity: 1 } : null,
            ]}
          />
          <View style={[styles.rim, shape]} pointerEvents="none" />
          {highlight ? <View style={styles.highlight} pointerEvents="none" /> : null}
          {children}
        </View>
      </View>
    )
  }

  return (
    <View
      testID={testID}
      onLayout={onLayout}
      pointerEvents={pointerEvents}
      style={[styles.shadow, elevated ? styles.elevated : null, shape, style]}
    >
      <View style={[styles.clip, styles.solid, shape, contentStyle]}>
        {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: solidTint(tint) }]} /> : null}
        {children}
      </View>
    </View>
  )
}

// A partly transparent tint over an opaque surface would show the surface
// through it; the solid treatment wants the tint at full strength.
function solidTint(tint: string) {
  return withAlpha(tint, 1)
}

const styles = StyleSheet.create((theme) => ({
  liquid: {
    borderCurve: 'continuous',
    // UIKit clips the glass to its corner configuration; RN still has to clip
    // children to the same shape.
    overflow: 'hidden',
  },
  liquidFill: {
    flex: 1,
  },
  liquidShadow: {
    borderCurve: 'continuous',
    boxShadow: theme.isDark
      ? '0px 6px 18px rgba(0, 0, 0, 0.32), 0px 0px 0px 0.5px rgba(255, 255, 255, 0.06)'
      : '0px 4px 16px rgba(17, 17, 24, 0.09), 0px 0px 0px 0.5px rgba(17, 17, 24, 0.07)',
  },
  shadow: {
    borderCurve: 'continuous',
  },
  elevated: {
    ...theme.shadow.md,
    // The panel is translucent, so a heavy drop shadow shows straight through
    // it; keep the ambient lift subtle.
    shadowOpacity: theme.isDark ? 0.35 : 0.1,
  },
  clip: {
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  solid: {
    backgroundColor: theme.colors.surface[2],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.emphasis,
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
