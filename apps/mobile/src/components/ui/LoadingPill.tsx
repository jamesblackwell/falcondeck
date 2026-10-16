import { memo, useEffect, useState } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { ActivityDiamond } from './ActivityDiamond'
import { GlassSurface } from './GlassSurface'
import { Text } from './Text'

/** Loads faster than this never show a pill: a flash of "Loading…" over a
 *  warm cache reads as jank, while a multi-second silent wait reads as a
 *  frozen list. */
export const LOADING_PILL_SHOW_AFTER_MS = 350

interface LoadingPillProps {
  visible: boolean
  label: string
  accessibilityLabel?: string
  testID?: string
}

/** Overlay chip for an in-flight list. Must stay out of flow. */
export const LoadingPill = memo(function LoadingPill({
  visible,
  label,
  accessibilityLabel,
  testID,
}: LoadingPillProps) {
  const { theme } = useUnistyles()
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!visible) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), LOADING_PILL_SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [visible])

  if (!visible || !shown) return null

  return (
    <View style={styles.wrapper} pointerEvents="none">
      <GlassSurface radius={16} intensity={70} highlight={false} pointerEvents="none">
      <View
        style={styles.pill}
        accessible
        accessibilityRole="progressbar"
        accessibilityLiveRegion="polite"
        accessibilityLabel={accessibilityLabel ?? label}
        testID={testID}
      >
        <ActivityDiamond
          size={theme.iconSize.xs}
          color={theme.colors.accent.default}
        />
        <Text variant="caption" size="xs" color="secondary" weight="medium">
          {label}
        </Text>
      </View>
      </GlassSurface>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: 'absolute',
    top: theme.spacing[2],
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1,
  },
  // A glass chip, like the rest of the floating chrome.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    minHeight: 32,
    paddingHorizontal: theme.spacing[3] + 2,
  },
}))
