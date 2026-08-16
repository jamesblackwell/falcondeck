import { memo, useState } from 'react'
import { View, type LayoutChangeEvent } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

const BAR_WIDTH = 3
const BAR_GAP = 3
const DOT_HEIGHT = 4
const MAX_BAR_HEIGHT = 26

/**
 * Scrolling loudness history for an in-composer recording session. Bars fill
 * from the left as levels arrive; unfilled slots read as faint dots, and once
 * the strip is full the oldest samples scroll off, iOS-voice-memo style.
 */
export const VoiceWaveform = memo(function VoiceWaveform({
  levels,
  muted = false,
}: {
  /** Loudness samples in [0, 1], oldest first. */
  levels: number[]
  /** Dims the strip while the recording is being transcribed. */
  muted?: boolean
}) {
  const [slotCount, setSlotCount] = useState(0)
  const handleLayout = (event: LayoutChangeEvent) => {
    setSlotCount(
      Math.max(
        0,
        Math.floor(
          (event.nativeEvent.layout.width + BAR_GAP) / (BAR_WIDTH + BAR_GAP),
        ),
      ),
    )
  }
  const visible = levels.slice(-slotCount)

  return (
    <View
      style={[styles.strip, muted && styles.stripMuted]}
      onLayout={handleLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: slotCount }, (_, index) => {
        const level = visible[index]
        return (
          <View
            key={index}
            style={[
              styles.bar,
              level === undefined
                ? styles.barPlaceholder
                : {
                    height:
                      DOT_HEIGHT + level * (MAX_BAR_HEIGHT - DOT_HEIGHT),
                  },
            ]}
          />
        )
      })}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  strip: {
    flex: 1,
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
    overflow: 'hidden',
  },
  stripMuted: {
    opacity: 0.4,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_WIDTH / 2,
    backgroundColor: theme.colors.fg.muted,
  },
  barPlaceholder: {
    height: DOT_HEIGHT,
    backgroundColor: theme.colors.fg.faint,
  },
}))
