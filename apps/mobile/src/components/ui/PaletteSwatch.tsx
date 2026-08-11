import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

export type PaletteSwatchColors = {
  bg: string
  surface: string
  fg: string
  accent: string
}

/**
 * A palette's identity in one chip: a circle quartered into canvas, raised
 * surface, text, and accent, so two schemes never look alike at 20pt. Mirrors
 * the conic-gradient swatch in packages/ui — same quadrant order, so the phone
 * and the desktop picker read as the same control.
 */
export const PaletteSwatch = memo(function PaletteSwatch({
  colors,
  size = 20,
}: {
  colors: PaletteSwatchColors
  size?: number
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <View style={styles.row}>
        <View style={[styles.quadrant, { backgroundColor: colors.bg }]} />
        <View style={[styles.quadrant, { backgroundColor: colors.surface }]} />
      </View>
      <View style={styles.row}>
        <View style={[styles.quadrant, { backgroundColor: colors.fg }]} />
        <View style={[styles.quadrant, { backgroundColor: colors.accent }]} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  circle: {
    overflow: 'hidden',
    borderWidth: 1,
    // Translucent ink rather than a token border: the chip has to stay legible
    // against whichever surface it lands on, including its own palette's.
    borderColor: theme.colors.border.strong,
  },
  row: { flex: 1, flexDirection: 'row' },
  quadrant: { flex: 1 },
}))
