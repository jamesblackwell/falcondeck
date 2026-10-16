import { memo } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { withAlpha } from '@/theme/color'

/** `[distance from the screen edge in points, opacity]`. */
export type ScrollEdgeStop = readonly [number, number]

interface ScrollEdgeProps {
  edge: 'top' | 'bottom'
  /** Total height of the fade. */
  height: number
  /**
   * Opacity stops measured from the screen edge. Defaults to an opaque band
   * of `solid` points that eases out to nothing at `height`.
   */
  stops?: readonly ScrollEdgeStop[]
  /** Height of the fully opaque band when no explicit stops are given. */
  solid?: number
  /** Colour content fades into; defaults to the screen background. */
  color?: string
  style?: StyleProp<ViewStyle>
}

function gradientFor(
  direction: string,
  base: string,
  height: number,
  stops: readonly ScrollEdgeStop[],
) {
  const parts = stops.map(([distance, alpha]) => {
    const percent = height > 0 ? Math.min(100, Math.max(0, (distance / height) * 100)) : 0
    return `${withAlpha(base, alpha)} ${percent.toFixed(1)}%`
  })
  return `linear-gradient(${direction}, ${parts.join(', ')})`
}

/**
 * The scroll edge effect behind floating chrome: content that scrolls under
 * a glass header or composer softens into the background instead of
 * colliding with the controls. Static rather than scroll-driven, so it costs
 * one gradient layer and no per-frame work.
 */
export const ScrollEdge = memo(function ScrollEdge({
  edge,
  height,
  stops,
  solid = 0,
  color,
  style,
}: ScrollEdgeProps) {
  const { theme } = useUnistyles()
  const base = color ?? theme.colors.surface[0]
  const resolvedStops: readonly ScrollEdgeStop[] = stops ?? [
    [0, 1],
    [solid, 1],
    [solid + (height - solid) * 0.5, 0.72],
    [height, 0],
  ]
  const gradient = gradientFor(edge === 'top' ? 'to bottom' : 'to top', base, height, resolvedStops)

  return (
    <View
      pointerEvents="none"
      style={[
        styles.edge,
        edge === 'top' ? styles.top : styles.bottom,
        { height, experimental_backgroundImage: gradient },
        style,
      ]}
    />
  )
})

const styles = StyleSheet.create(() => ({
  edge: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
}))
